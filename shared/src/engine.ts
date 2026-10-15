import { CONFIG } from './config.ts';
import { GRID } from './layout.ts';
import type { Snapshot } from './types.ts';

// Headless, deterministic combat engine (fixed ticks, seeded RNG, no wall clock).
// Used on the server for both zombie waves and PvP; clients only render the snapshots it produces.
//
// Units walk straight at their target. Anything solid in the way (a wall, a post) gets attacked
// until it falls, then they carry on. Posts shoot the nearest unit in range.

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
  state: 'move' | 'attack' | 'dead';
  facing: 1 | -1;
  targetId: number;
  cooldown: number;
  diedAt: number;
}

export interface StepResult {
  kills: { unitId: number; kind: number }[];
  destroyed: number[];
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

export class Combat {
  tick = 0;
  readonly units: Unit[] = [];
  readonly buildings = new Map<number, Building>();
  readonly rng: () => number;
  private nextUnitId = 1000;
  /** tile index -> building id, for solid buildings. */
  private solid = new Map<number, number>();
  private dirty = new Set<number>();
  private shots: [number, number, number][] = [];
  private readonly dt = 1 / CONFIG.tickRate;

  constructor(seed: number, defs: BuildingDef[]) {
    this.rng = mulberry32(seed);
    for (const d of defs) {
      const b: Building = { ...d, maxHp: d.hp, alive: true, reload: 0 };
      this.buildings.set(d.id, b);
      for (let y = d.y; y < d.y + d.h; y++) for (let x = d.x; x < d.x + d.w; x++) this.solid.set(y * GRID + x, d.id);
    }
  }

  get hq(): Building | undefined {
    for (const b of this.buildings.values()) if (b.kind === 'hq') return b;
    return undefined;
  }

  get hqDestroyed(): boolean {
    return !this.hq?.alive;
  }

  get liveUnits(): number {
    return this.units.filter((u) => u.state !== 'dead').length;
  }

  addUnit(kind: number, stats: UnitStats, x: number, y: number): Unit {
    const u: Unit = {
      id: this.nextUnitId++,
      kind,
      x,
      y,
      hp: stats.hp,
      maxHp: stats.hp,
      stats,
      state: 'move',
      facing: 1,
      targetId: -1,
      cooldown: 0,
      diedAt: 0,
    };
    this.units.push(u);
    return u;
  }

  /** Distance from a point to the nearest edge of a building's footprint. */
  private distTo(b: Building, x: number, y: number): number {
    const cx = Math.max(b.x, Math.min(x, b.x + b.w));
    const cy = Math.max(b.y, Math.min(y, b.y + b.h));
    return Math.hypot(x - cx, y - cy);
  }

  private solidAt(x: number, y: number): Building | undefined {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= GRID || ty >= GRID) return undefined;
    const id = this.solid.get(ty * GRID + tx);
    const b = id === undefined ? undefined : this.buildings.get(id);
    return b?.alive ? b : undefined;
  }

  /** Units go for the HQ; if it's gone, the nearest surviving building. */
  private pickTarget(u: Unit): Building | undefined {
    const hq = this.hq;
    if (hq?.alive) return hq;
    let best: Building | undefined;
    let bestD = Infinity;
    for (const b of this.buildings.values()) {
      if (!b.alive) continue;
      const d = this.distTo(b, u.x, u.y);
      if (d < bestD) (best = b), (bestD = d);
    }
    return best;
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
      res.kills.push({ unitId: u.id, kind: u.kind });
    }
  }

  step(): StepResult {
    const res: StepResult = { kills: [], destroyed: [] };
    const dt = this.dt;

    // 1. Units move or attack.
    for (const u of this.units) {
      if (u.state === 'dead') continue;
      let target = this.buildings.get(u.targetId);
      if (!target?.alive) {
        target = this.pickTarget(u);
        u.targetId = target?.id ?? -1;
        u.state = 'move';
      }
      if (!target) continue;
      u.cooldown = Math.max(0, u.cooldown - dt);
      if (this.distTo(target, u.x, u.y) <= u.stats.range) {
        u.state = 'attack';
        if (u.cooldown === 0) {
          this.damage(target, u.stats.damage * (target.kind === 'wall' ? u.stats.wallMult : 1), res);
          u.cooldown = u.stats.cooldown;
        }
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
    }

    // 2. Posts shoot.
    for (const b of this.buildings.values()) {
      if (!b.alive || !b.gun) continue;
      b.reload = Math.max(0, b.reload - dt);
      if (b.reload > 0) continue;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      let best: Unit | undefined;
      let bestD = Infinity;
      for (const u of this.units) {
        if (u.state === 'dead') continue;
        const d = Math.hypot(u.x - cx, u.y - cy);
        if (d <= b.gun.range && d < bestD) (best = u), (bestD = d);
      }
      if (!best) continue;
      b.reload = b.gun.cooldown;
      this.shots.push([b.id, Math.round(best.x * 16), Math.round(best.y * 16)]);
      if (b.gun.splash > 0) {
        const tx = best.x;
        const ty = best.y;
        for (const u of this.units) if (u.state !== 'dead' && Math.hypot(u.x - tx, u.y - ty) <= b.gun.splash) this.hurt(u, b.gun.damage, res);
      } else {
        this.hurt(best, b.gun.damage, res);
      }
    }

    // 3. Forget long-dead units (after their death animation has been streamed).
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i]!;
      if (u.state === 'dead' && this.tick - u.diedAt > DEAD_LINGER_TICKS) this.units.splice(i, 1);
    }

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
        const bd = this.buildings.get(id)!;
        b.push([id, Math.round((100 * bd.hp) / bd.maxHp)]);
      }
      this.dirty.clear();
      s = this.shots;
      this.shots = [];
    }
    return {
      t: this.tick,
      u: this.units.map((u) => [u.id, u.kind, Math.round(u.x * 16), Math.round(u.y * 16), Math.round((100 * u.hp) / u.maxHp), u.state === 'move' ? 0 : u.state === 'attack' ? 1 : 2, u.facing]),
      b,
      s,
    };
  }
}
