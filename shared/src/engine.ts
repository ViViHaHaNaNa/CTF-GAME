import { CONFIG } from './config.ts';
import type { Snapshot } from './types.ts';

// Headless, deterministic combat engine (fixed ticks, seeded RNG, no wall clock).
// Used on the server for both zombie sieges and PvP; clients only render the snapshots it produces.
//
// Coordinates are world tiles. Units walk straight at their target. Anything solid in the way (a wall,
// a post) gets attacked until it falls, then they carry on. Posts shoot the nearest unit in range.
// Zombies go for the Main Tower; raiders go for the nearest non-wall building.
//
// Units sit in a spatial hash (1-tile cells) rebuilt every tick, so posts find their nearest target
// and crowds push apart without comparing every unit with every other one. Dead units go back to a
// pool. Two optional modes: `crowd` (zombie mobs spread out instead of walking in single file) and
// `coarse` (headless resolution at a lower tick rate, for bases nobody is looking at).

export type BuildingKind = 'hq' | 'post' | 'wall';

export interface PostGun {
  range: number;
  damage: number;
  /** seconds */
  cooldown: number;
  /** Splash radius in tiles (0 = single target). */
  splash: number;
}

export interface BuildingDef {
  id: number;
  kind: BuildingKind;
  /** Top-left tile and size in tiles. */
  x: number;
  y: number;
  w: number;
  h: number;
  hp: number;
  gun?: PostGun;
}

export interface UnitStats {
  hp: number;
  /** tiles per second */
  speed: number;
  damage: number;
  /** seconds between hits */
  cooldown: number;
  /** attack reach in tiles (measured to the edge of the target) */
  range: number;
  /** damage multiplier against walls */
  wallMult: number;
  /** 'hq': head for the Main Tower (zombies). 'nearest': nearest non-wall building (raiders). */
  target?: 'hq' | 'nearest';
  /** Body radius in tiles for crowd separation (crowd mode only). */
  radius?: number;
}

export interface Building extends BuildingDef {
  maxHp: number;
  alive: boolean;
  reload: number;
}

export interface Unit {
  id: number;
  /** Index into the client's unit-kind table (for sprites). */
  kind: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  stats: UnitStats;
  /** 'rise' = climbing out of the ground: harmless and untargetable until `wakeAt`. */
  state: 'rise' | 'move' | 'attack' | 'dead';
  wakeAt: number;
  facing: 1 | -1;
  targetId: number;
  cooldown: number;
  diedAt: number;
  /** Free for the caller (sieges store the surge number here). */
  tag: number;
}

export interface StepResult {
  kills: { unitId: number; kind: number; tag: number; x: number; y: number }[];
  destroyed: number[];
}

export interface CombatOptions {
  /** Units push apart (zombie mobs). */
  crowd?: boolean;
  /** Headless resolution: CONFIG.siege.coarseRate ticks/s; attack timers carry their remainder so rates stay exact. */
  coarse?: boolean;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEAD_LINGER_TICKS = 12;
const STATE_CODE = { move: 0, attack: 1, dead: 2, rise: 3 } as const;
/** Unit ids cycle through this range (they fit a u16 on the wire and never clash with building ids). */
const FIRST_UNIT_ID = 1000;
const LAST_UNIT_ID = 65000;
/** The hash covers the buildings plus this many tiles around them; units further out share the edge cells. */
const HASH_MARGIN = 10;
/** Furthest a crowd push moves a unit in one second (tiles). */
const PUSH_SPEED = 2.5;

export class Combat {
  tick = 0;
  readonly units: Unit[] = [];
  readonly buildings = new Map<number, Building>();
  readonly rng: () => number;
  /** Ticks per second this fight runs at. */
  readonly rate: number;
  readonly crowd: boolean;
  private readonly carry: boolean;
  private nextUnitId = FIRST_UNIT_ID;
  private pool: Unit[] = [];
  private alive = 0;
  /** tile index -> building id, for solid buildings. */
  private solid = new Map<number, number>();
  private dirty = new Set<number>();
  private shots: [number, number, number][] = [];
  private readonly dt: number;
  // Spatial hash: cell -> first unit index, unit index -> next unit index in the same cell.
  private hx = 0;
  private hy = 0;
  private hw = 1;
  private hh = 1;
  private head = new Int32Array(1);
  private next = new Int32Array(64);

  constructor(seed: number, defs: BuildingDef[], opts: CombatOptions = {}) {
    this.rng = mulberry32(seed);
    this.rate = opts.coarse ? CONFIG.siege.coarseRate : CONFIG.tickRate;
    this.dt = 1 / this.rate;
    this.crowd = !!opts.crowd;
    this.carry = !!opts.coarse;
    this.setBuildings(defs);
    this.dirty.clear();
  }

  get hq(): Building | undefined {
    for (const b of this.buildings.values()) if (b.kind === 'hq') return b;
    return undefined;
  }

  get hqDestroyed(): boolean {
    return !this.hq?.alive;
  }

  /** Units not dead (rising ones included). */
  get liveUnits(): number {
    return this.alive;
  }

  /**
   * Add, update or remove buildings to match `defs` (a base upgraded mid-fight). Updated ones keep
   * their health share; fallen ones stay down until repaired; new ones arrive at full health.
   */
  setBuildings(defs: BuildingDef[]) {
    const keep = new Set<number>();
    for (const d of defs) {
      keep.add(d.id);
      const old = this.buildings.get(d.id);
      if (old) {
        const share = old.hp / old.maxHp;
        Object.assign(old, d, { maxHp: d.hp, hp: old.alive ? Math.max(1, Math.round(share * d.hp)) : 0 });
      } else this.buildings.set(d.id, { ...d, maxHp: d.hp, alive: true, reload: 0 });
      this.dirty.add(d.id);
    }
    for (const id of [...this.buildings.keys()]) if (!keep.has(id)) this.buildings.delete(id);
    this.solid.clear();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of this.buildings.values()) {
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) this.solid.set(y * 4096 + x, b.id);
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    if (x0 === Infinity) x0 = y0 = x1 = y1 = 0;
    this.hx = Math.floor(x0) - HASH_MARGIN;
    this.hy = Math.floor(y0) - HASH_MARGIN;
    this.hw = Math.ceil(x1) - this.hx + HASH_MARGIN;
    this.hh = Math.ceil(y1) - this.hy + HASH_MARGIN;
    this.head = new Int32Array(this.hw * this.hh);
  }

  /** Give every building back `share` of its max health; fallen ones are rebuilt at that share. */
  repair(share: number) {
    for (const b of this.buildings.values()) {
      const hp = b.alive ? Math.min(b.maxHp, b.hp + Math.round(b.maxHp * share)) : Math.max(1, Math.round(b.maxHp * share));
      if (hp === b.hp && b.alive) continue;
      b.hp = hp;
      b.alive = true;
      this.dirty.add(b.id);
    }
  }

  /** Every unit drops dead at once (no kill rewards): the field is cleared. */
  killAll() {
    for (const u of this.units) {
      if (u.state === 'dead') continue;
      u.state = 'dead';
      u.diedAt = this.tick;
      this.alive--;
    }
  }

  /** `riseTicks` > 0: the unit first climbs out of the ground for that long. */
  addUnit(kind: number, stats: UnitStats, x: number, y: number, riseTicks = 0, tag = 0): Unit {
    const u = this.pool.pop() ?? ({} as Unit);
    u.id = this.nextUnitId;
    this.nextUnitId = this.nextUnitId >= LAST_UNIT_ID ? FIRST_UNIT_ID : this.nextUnitId + 1;
    u.kind = kind;
    u.x = x;
    u.y = y;
    u.hp = stats.hp;
    u.maxHp = stats.hp;
    u.stats = stats;
    u.state = riseTicks > 0 ? 'rise' : 'move';
    u.wakeAt = this.tick + riseTicks;
    u.facing = 1;
    u.targetId = -1;
    u.cooldown = 0;
    u.diedAt = 0;
    u.tag = tag;
    this.units.push(u);
    this.alive++;
    return u;
  }

  /** Distance from a point to the nearest edge of a building's footprint. */
  private distTo(b: Building, x: number, y: number): number {
    const cx = Math.max(b.x, Math.min(x, b.x + b.w));
    const cy = Math.max(b.y, Math.min(y, b.y + b.h));
    return Math.hypot(x - cx, y - cy);
  }

  private solidAt(x: number, y: number): Building | undefined {
    const id = this.solid.get(Math.floor(y) * 4096 + Math.floor(x));
    const b = id === undefined ? undefined : this.buildings.get(id);
    return b?.alive ? b : undefined;
  }

  /** Zombies: the HQ. Raiders: the nearest non-wall building. Fallback: the nearest anything. */
  private pickTarget(u: Unit): Building | undefined {
    const hq = this.hq;
    if ((u.stats.target ?? 'hq') === 'hq' && hq?.alive) return hq;
    let best: Building | undefined;
    let bestD = Infinity;
    for (const pass of [false, true]) {
      for (const b of this.buildings.values()) {
        if (!b.alive || (!pass && b.kind === 'wall')) continue;
        const d = this.distTo(b, u.x, u.y);
        if (d < bestD) (best = b), (bestD = d);
      }
      if (best) break;
    }
    return best;
  }

  /** Share of non-wall buildings destroyed (0..1): the PvP "destruction" score. */
  destruction(): number {
    let all = 0;
    let down = 0;
    for (const b of this.buildings.values()) {
      if (b.kind === 'wall') continue;
      all++;
      if (!b.alive) down++;
    }
    return all ? down / all : 0;
  }

  private damage(b: Building, amount: number, res: StepResult) {
    if (!b.alive) return;
    b.hp = Math.max(0, b.hp - amount);
    this.dirty.add(b.id);
    if (b.hp === 0) {
      b.alive = false;
      res.destroyed.push(b.id);
    }
  }

  private hurt(u: Unit, amount: number, res: StepResult) {
    if (u.state === 'dead') return;
    u.hp -= amount;
    if (u.hp <= 0) {
      u.hp = 0;
      u.state = 'dead';
      u.diedAt = this.tick;
      this.alive--;
      res.kills.push({ unitId: u.id, kind: u.kind, tag: u.tag, x: u.x, y: u.y });
    }
  }

  // ---- spatial hash ---------------------------------------------------------------------------------

  private cellX(x: number) {
    return Math.min(this.hw - 1, Math.max(0, Math.floor(x) - this.hx));
  }

  private cellY(y: number) {
    return Math.min(this.hh - 1, Math.max(0, Math.floor(y) - this.hy));
  }

  /** Bucket every live unit by cell. Within a cell, units are listed in array order. */
  private rehash() {
    const n = this.units.length;
    if (this.next.length < n) this.next = new Int32Array(Math.max(n, this.next.length * 2));
    this.head.fill(-1);
    // Walk backwards and push to the front, so each cell's list ends up in ascending index order.
    for (let i = n - 1; i >= 0; i--) {
      const u = this.units[i]!;
      if (u.state === 'dead') continue;
      const c = this.cellY(u.y) * this.hw + this.cellX(u.x);
      this.next[i] = this.head[c]!;
      this.head[c] = i;
    }
  }

  /**
   * Nearest targetable unit within `range` of (x, y), searching outward ring by ring. Ties go to the
   * unit earliest in the array: exactly what a plain scan over every unit would pick.
   */
  private nearest(x: number, y: number, range: number): Unit | undefined {
    const cx = this.cellX(x);
    const cy = this.cellY(y);
    let best = -1;
    let bestD = Infinity;
    const maxRing = Math.max(this.hw, this.hh);
    for (let r = 0; r <= maxRing; r++) {
      // Anything in ring r is at least r - 1 tiles away.
      if (r - 1 > Math.min(range, bestD)) break;
      for (let gy = cy - r; gy <= cy + r; gy++) {
        if (gy < 0 || gy >= this.hh) continue;
        const edgeRow = gy === cy - r || gy === cy + r;
        for (let gx = cx - r; gx <= cx + r; gx += edgeRow ? 1 : 2 * r || 1) {
          if (gx < 0 || gx >= this.hw) continue;
          for (let i = this.head[gy * this.hw + gx]!; i >= 0; i = this.next[i]!) {
            const u = this.units[i]!;
            if (u.state === 'rise' || u.state === 'dead') continue;
            const d = Math.hypot(u.x - x, u.y - y);
            if (d <= range && (d < bestD || (d === bestD && i < best))) (best = i), (bestD = d);
          }
        }
      }
    }
    return best >= 0 ? this.units[best] : undefined;
  }

  /** Units within `radius` of (x, y), in array order (splash damage). */
  private within(x: number, y: number, radius: number, out: Unit[]) {
    out.length = 0;
    const gx0 = this.cellX(x - radius), gx1 = this.cellX(x + radius);
    const gy0 = this.cellY(y - radius), gy1 = this.cellY(y + radius);
    const idx: number[] = [];
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++)
        for (let i = this.head[gy * this.hw + gx]!; i >= 0; i = this.next[i]!) {
          const u = this.units[i]!;
          if (u.state !== 'rise' && u.state !== 'dead' && Math.hypot(u.x - x, u.y - y) <= radius) idx.push(i);
        }
    idx.sort((a, b) => a - b);
    for (const i of idx) out.push(this.units[i]!);
  }

  /** Crowd mode: a walking unit is nudged away from bodies it overlaps (never into anything solid). */
  private separate(i: number, u: Unit) {
    const r = u.stats.radius ?? 0.3;
    let px = 0;
    let py = 0;
    const cx = this.cellX(u.x);
    const cy = this.cellY(u.y);
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(this.hh - 1, cy + 1); gy++)
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(this.hw - 1, cx + 1); gx++)
        for (let j = this.head[gy * this.hw + gx]!; j >= 0; j = this.next[j]!) {
          if (j === i) continue;
          const v = this.units[j]!;
          if (v.state === 'dead' || v.state === 'rise') continue;
          const min = r + (v.stats.radius ?? 0.3);
          let dx = u.x - v.x;
          let dy = u.y - v.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-6) {
            // Exactly on top of each other: split them by id.
            dx = u.id < v.id ? 1 : -1;
            dy = 0;
            d = 1;
          }
          const k = (min - Math.min(d, min)) / d;
          px += dx * k;
          py += dy * k;
        }
    if (px === 0 && py === 0) return;
    const max = PUSH_SPEED * this.dt;
    const len = Math.sqrt(px * px + py * py);
    if (len > max) {
      px = (px / len) * max;
      py = (py / len) * max;
    }
    const nx = u.x + px * 0.5;
    const ny = u.y + py * 0.5;
    if (!this.solidAt(nx, ny)) {
      u.x = nx;
      u.y = ny;
    }
  }

  // ---- taps & blasts (outside the normal tick) --------------------------------------------------------

  /**
   * Live, targetable units within `radius` of (x, y), closest to the point first (ties: earliest in the
   * array). Uses the spatial hash, so it stays cheap with hundreds of zombies.
   */
  unitsNear(x: number, y: number, radius: number): Unit[] {
    this.rehash();
    const found: { u: Unit; d: number; i: number }[] = [];
    const gx0 = this.cellX(x - radius), gx1 = this.cellX(x + radius);
    const gy0 = this.cellY(y - radius), gy1 = this.cellY(y + radius);
    for (let gy = gy0; gy <= gy1; gy++)
      for (let gx = gx0; gx <= gx1; gx++)
        for (let i = this.head[gy * this.hw + gx]!; i >= 0; i = this.next[i]!) {
          const u = this.units[i]!;
          if (u.state === 'rise' || u.state === 'dead') continue;
          const d = Math.hypot(u.x - x, u.y - y);
          if (d <= radius) found.push({ u, d, i });
        }
    found.sort((a, b) => a.d - b.d || a.i - b.i);
    return found.map((f) => f.u);
  }

  /** Damage a unit between ticks (a tap or an airstrike). Kills are added to `kills`; true if this one died. */
  strike(u: Unit, amount: number, kills: StepResult['kills']): boolean {
    const res: StepResult = { kills, destroyed: [] };
    this.hurt(u, amount, res);
    return u.state === 'dead';
  }

  // ---- simulation -------------------------------------------------------------------------------------

  /** Count down an attack timer; true when it fires (and it's reloaded). */
  private ready(t: { cooldown: number } | { reload: number }, key: 'cooldown' | 'reload', inRange: boolean, every: number): boolean {
    const o = t as Record<string, number>;
    if (!this.carry) {
      o[key] = Math.max(0, o[key]! - this.dt);
      if (!inRange || o[key] !== 0) return false;
      o[key] = every;
      return true;
    }
    // Coarse ticks: keep the leftover so a 0.42 s timer fires every 0.42 s on average, not every 0.5 s.
    o[key] = o[key]! - this.dt;
    if (!inRange) {
      if (o[key]! < 0) o[key] = 0;
      return false;
    }
    if (o[key]! > 1e-9) return false;
    o[key] = o[key]! + every;
    return true;
  }

  step(): StepResult {
    const res: StepResult = { kills: [], destroyed: [] };
    const dt = this.dt;
    if (this.crowd) this.rehash();

    // 1. Units move or attack.
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i]!;
      if (u.state === 'dead') continue;
      if (u.state === 'rise') {
        if (this.tick < u.wakeAt) continue;
        u.state = 'move';
      }
      let target = this.buildings.get(u.targetId);
      if (!target?.alive) {
        target = this.pickTarget(u);
        u.targetId = target?.id ?? -1;
        u.state = 'move';
      }
      if (!target) continue;
      const inRange = this.distTo(target, u.x, u.y) <= u.stats.range;
      if (this.ready(u, 'cooldown', inRange, u.stats.cooldown)) {
        this.damage(target, u.stats.damage * (target.kind === 'wall' ? u.stats.wallMult : 1), res);
        // Ranged attackers leave a visible shot (posts' shots are recorded below).
        if (u.stats.range > 1) this.shots.push([u.id, Math.round((target.x + target.w / 2) * 16), Math.round((target.y + target.h / 2) * 16)]);
      }
      if (inRange) {
        u.state = 'attack';
        continue;
      }
      // Walk towards the target's centre.
      const tx = target.x + target.w / 2;
      const ty = target.y + target.h / 2;
      const d = Math.hypot(tx - u.x, ty - u.y) || 1;
      const step = u.stats.speed * dt;
      const nx = u.x + ((tx - u.x) / d) * step;
      const ny = u.y + ((ty - u.y) / d) * step;
      if (Math.abs(tx - u.x) > 0.05) u.facing = tx > u.x ? 1 : -1;
      const blocker = this.solidAt(nx, ny);
      if (blocker && blocker.id !== target.id) {
        // Something solid in the way: hack through it first.
        u.targetId = blocker.id;
        u.state = 'attack';
        continue;
      }
      u.x = nx;
      u.y = ny;
      u.state = 'move';
      if (this.crowd) this.separate(i, u);
    }

    // 2. Posts shoot.
    this.rehash();
    const splashed: Unit[] = [];
    for (const b of this.buildings.values()) {
      if (!b.alive || !b.gun) continue;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      // Only look for a target when the gun is (about to be) ready.
      const best = b.reload - this.dt <= 1e-9 ? this.nearest(cx, cy, b.gun.range) : undefined;
      if (!this.ready(b, 'reload', !!best, b.gun.cooldown) || !best) continue;
      this.shots.push([b.id, Math.round(best.x * 16), Math.round(best.y * 16)]);
      if (b.gun.splash > 0) {
        this.within(best.x, best.y, b.gun.splash, splashed);
        for (const u of splashed) this.hurt(u, b.gun.damage, res);
      } else {
        this.hurt(best, b.gun.damage, res);
      }
    }

    // 3. Forget long-dead units (after their death animation has been streamed); they go back to the pool.
    let w = 0;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i]!;
      if (u.state === 'dead' && this.tick - u.diedAt > DEAD_LINGER_TICKS) this.pool.push(u);
      else this.units[w++] = u;
    }
    this.units.length = w;

    this.tick++;
    return res;
  }

  /**
   * Compact state for clients. Incremental snapshots carry only buildings whose hp changed and the
   * shots fired since the last one. `full` (for a screen that just joined) has every building and
   * does not consume the incremental changes.
   */
  snapshot(full = false): Snapshot {
    const b: [number, number][] = [];
    let s: [number, number, number][] = [];
    if (full) {
      for (const bd of this.buildings.values()) b.push([bd.id, Math.round((100 * bd.hp) / bd.maxHp)]);
    } else {
      for (const id of this.dirty) {
        const bd = this.buildings.get(id);
        if (bd) b.push([id, Math.round((100 * bd.hp) / bd.maxHp)]);
      }
      this.dirty.clear();
      s = this.shots;
      this.shots = [];
    }
    return {
      t: this.tick,
      u: this.units.map((u) => [u.id, u.kind, Math.round(u.x * 16), Math.round(u.y * 16), Math.round((100 * u.hp) / u.maxHp), STATE_CODE[u.state], u.facing]),
      b,
      s,
    };
  }
}
