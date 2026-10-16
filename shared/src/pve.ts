import { CONFIG, UNIT_KINDS, postStats, type ZombieKind } from './config.ts';
import { Combat, mulberry32, type BuildingDef, type UnitStats } from './engine.ts';
import { HQ_RECT, PLOT, SLOTS, WALLS } from './layout.ts';
import type { BaseState } from './types.ts';
import { getWorld, sideTile, type WorldPlot } from './world.ts';

// Zombie defence (PvE): one continuous siege per base. Surges come from every side at once: the
// base's graveyard, the street/alley edges, its manholes and cracks opening in the yard. A director
// runs the rhythm (a peak, a 3-5 s breather, the next peak, a thin trickle in between), the scripted
// first minute, pincers later on, and dynamic difficulty. Zombies only ever attack their own base.
//
// Everything is decided by the base, its plot, a seed and the director's state, so a siege plays out
// the same way online (streamed live) or headless (offline bases, resolved at a coarse tick rate).

export const HQ_ID = 1;
export const wallId = (i: number) => 100 + i;
export const postId = (slot: number) => 200 + slot;

/** Sides of a base: 0 north, 1 east, 2 south, 3 west, and 4 = its graveyard (the inner corner). */
export const SIDE_NAMES = ['north', 'east', 'south', 'west', 'graveyard'] as const;
export const GRAVEYARD_SIDE = 4;

/**
 * A base's buildings placed on its plot (world tiles). `siege`: post ranges stretched per
 * CONFIG.siege.postRange so every post covers every wall (raids use the plain ranges).
 */
export function baseBuildings(base: BaseState, plot: { x: number; y: number }, defenceBoost = 0, siege = false): BuildingDef[] {
  const reach = CONFIG.siege.postRange;
  const boost = 1 + defenceBoost;
  const ox = plot.x;
  const oy = plot.y;
  const defs: BuildingDef[] = [{ id: HQ_ID, kind: 'hq', x: ox + HQ_RECT.x, y: oy + HQ_RECT.y, w: HQ_RECT.w, h: HQ_RECT.h, hp: CONFIG.hq.hp(base.hq) }];
  const wallHp = CONFIG.walls.hp(base.walls);
  for (const w of WALLS) defs.push({ id: wallId(w.i), kind: 'wall', x: ox + w.x, y: oy + w.y, w: 1, h: 1, hp: wallHp });
  base.posts.forEach((p, slot) => {
    if (!p) return;
    const s = SLOTS[slot]!;
    const st = postStats(p.type, p.level);
    defs.push({ id: postId(slot), kind: 'post', x: ox + s.x, y: oy + s.y, w: 1, h: 1, hp: Math.round(st.hp * boost), gun: { range: siege ? Math.max(reach.min, st.range * reach.mult) : st.range, damage: Math.round(st.damage * boost), cooldown: st.cooldown, splash: st.splash } });
  });
  return defs;
}

export function zombieStats(kind: ZombieKind, hq: number): UnitStats {
  const z = CONFIG.zombies[kind];
  return {
    hp: Math.round(z.hp * CONFIG.siege.hpScale(hq)),
    speed: z.speed * CONFIG.pace.zombieSpeed,
    damage: Math.round(z.damage * CONFIG.siege.damageScale(hq)),
    cooldown: z.cooldown * CONFIG.pace.zombieCooldown,
    range: z.range,
    wallMult: z.wallMult,
    target: 'hq',
    radius: z.radius,
  };
}

export function killCoins(kind: ZombieKind, hq: number): number {
  // Rounded down so a Small is always worth exactly 1: lots of little pops, not runaway income.
  return Math.max(1, Math.floor(CONFIG.zombies[kind].coins * CONFIG.siege.coinScale(hq)));
}

/** Firepower: how many Smalls per second a base's posts can shoot down (splash counts as hitting a few). */
export function firepower(base: BaseState, defenceBoost = 0): number {
  const hp = zombieStats('z_small', base.hq).hp;
  let kills = 0;
  for (const p of base.posts) {
    if (!p) continue;
    const st = postStats(p.type, p.level);
    const shots = Math.ceil(hp / Math.round(st.damage * (1 + defenceBoost)));
    kills += (1 / st.cooldown / shots) * (st.splash > 0 ? 2.5 : 1);
  }
  return kills;
}

/** Coins lost to a breach: a capped share, never dropping the player below the protected floor. */
export function breachLoss(coins: number): number {
  const b = CONFIG.siege.breach;
  return Math.max(0, Math.min(coins - b.protectedFloor, Math.round(coins * b.lossPct), b.maxLoss));
}

/** What the director remembers about a player between sessions (saved with the player). */
export interface DirectorState {
  /** Multiplies surge size; moves after every surge to keep the held share on target. */
  pressure: number;
  /** Seconds of siege played while online (surges grow with it). */
  played: number;
  surges: number;
  held: number;
}

export function newDirector(): DirectorState {
  return { pressure: CONFIG.siege.difficulty.start, played: 0, surges: 0, held: 0 };
}

export type SiegeEvent =
  | { type: 'surge'; n: number; size: number; sides: number[]; pincer: boolean }
  | { type: 'held'; n: number; kills: number; coins: number }
  | { type: 'breach'; n: number };

export interface SiegeOptions {
  /** Extra post damage/health from a crate boost (0.25 = +25%). */
  defenceBoost?: number;
  /** Headless resolution at a coarse tick rate (offline bases). */
  coarse?: boolean;
  /** Start with the scripted first minute (default true; headless runs skip it). */
  ramp?: boolean;
  /** Seconds before the first surge (default CONFIG.siege.firstSurge). */
  firstDelay?: number;
}

interface Spawn {
  at: number;
  kind: ZombieKind;
  x: number;
  y: number;
  rise: boolean;
}

type Phase = 'start' | 'surge' | 'breather';

export class Siege {
  readonly combat: Combat;
  /** Things worth telling players about since the caller last emptied this. */
  readonly events: SiegeEvent[] = [];
  phase: Phase = 'start';
  /** Tick when the current wait ends (start / breather). */
  until: number;
  /** Surges started this session. */
  n = 0;
  kills = 0;
  coins = 0;
  breaches = 0;
  /** Count played time for the director (the owner is online). */
  counting = true;
  private readonly rng: () => number;
  private readonly rampOn: boolean;
  private base: BaseState;
  private boost: number;
  private queue: Spawn[] = [];
  private qi = 0;
  private surgeStart = 0;
  private surgeAlive = 0;
  private surgeKills = 0;
  private surgeCoins = 0;
  private eased = false;
  private nextTrickle = 0;
  /** How far out the edge spawns may be on each side (street: further than an alley). */
  private readonly edgeOut: number[];
  private readonly manholes: ({ x: number; y: number } | null)[];
  private readonly graves: { x: number; y: number }[];
  private readonly hqX: number;
  private readonly hqY: number;

  constructor(base: BaseState, readonly plot: WorldPlot, seed: number, readonly director: DirectorState, opts: SiegeOptions = {}) {
    this.base = base;
    this.boost = opts.defenceBoost ?? 0;
    this.combat = new Combat(seed, baseBuildings(base, plot, opts.defenceBoost ?? 0, true), { crowd: true, coarse: opts.coarse });
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.rampOn = opts.ramp ?? true;
    this.until = this.ticks(opts.firstDelay ?? CONFIG.siege.firstSurge);
    const world = getWorld();
    this.edgeOut = [0, 1, 2, 3].map((side) => {
      const [x, y] = sideTile(plot, side, 7, 2);
      return world.ground[y * world.w + x] === 1 ? 3.2 : 1.6;
    });
    this.manholes = [0, 1, 2, 3].map((side) => world.manholes.find((m) => m.plot === plot.id && m.side === side) ?? null);
    this.graves = world.graveyards[plot.graveyard]!.graves;
    this.hqX = plot.x + HQ_RECT.x + HQ_RECT.w / 2;
    this.hqY = plot.y + HQ_RECT.y + HQ_RECT.h / 2;
  }

  private ticks(seconds: number) {
    return Math.round(seconds * this.combat.rate);
  }

  /** The base changed (an upgrade, a new post): it joins the fight right away. */
  setBase(base: BaseState, defenceBoost = 0) {
    this.base = base;
    this.boost = defenceBoost;
    this.combat.setBuildings(baseBuildings(base, this.plot, defenceBoost, true));
  }

  /** Seconds until the next surge (0 while one is on). */
  nextIn(): number {
    return this.phase === 'surge' ? 0 : Math.max(0, (this.until - this.combat.tick) / this.combat.rate);
  }

  private target(): number {
    const d = CONFIG.siege.difficulty;
    return this.director.played / 60 < d.newMinutes ? d.targetNew : d.target;
  }

  /** Main Tower health share (0..1). */
  hqShare(): number {
    const hq = this.combat.hq;
    return hq ? hq.hp / hq.maxHp : 0;
  }

  /** One tick. Returns coins earned by kills this tick. */
  step(): number {
    const c = this.combat;
    const S = CONFIG.siege;
    if (this.counting) this.director.played += 1 / c.rate;
    if (this.phase !== 'surge' && c.tick >= this.until) this.startSurge();
    const rise = this.ticks(S.riseTime);
    while (this.qi < this.queue.length && this.queue[this.qi]!.at <= c.tick && c.liveUnits < S.maxAlive) {
      const s = this.queue[this.qi++]!;
      c.addUnit(UNIT_KINDS.indexOf(s.kind), zombieStats(s.kind, this.base.hq), s.x, s.y, s.rise ? rise : 0, this.n);
      this.surgeAlive++;
    }
    if (this.phase === 'breather' && c.tick >= this.nextTrickle) {
      this.nextTrickle = c.tick + this.ticks(S.trickleEvery);
      // A stray: never while the base is losing, and never over the cap.
      if (this.hqShare() >= S.difficulty.easeBelow && c.liveUnits < S.maxAlive) {
        const s = this.spawnAt(Math.floor(this.rng() * 4), 'z_small', 0);
        c.addUnit(UNIT_KINDS.indexOf('z_small'), zombieStats('z_small', this.base.hq), s.x, s.y, s.rise ? rise : 0, 0);
      }
    }

    const r = c.step();
    let earned = 0;
    for (const k of r.kills) {
      const coins = killCoins(UNIT_KINDS[k.kind] as ZombieKind, this.base.hq);
      earned += coins;
      if (this.phase === 'surge' && k.tag === this.n) {
        this.surgeAlive--;
        this.surgeKills++;
        this.surgeCoins += coins;
      }
    }
    this.kills += r.kills.length;
    this.coins += earned;

    if (c.hqDestroyed) {
      this.breach();
      return earned;
    }
    if (this.phase === 'surge') {
      // Falling behind: thin out the rest of this surge.
      if (!this.eased && this.hqShare() < S.difficulty.easeBelow) {
        this.eased = true;
        const rest = this.queue.slice(this.qi);
        const keep = Math.round(rest.length * S.difficulty.easeKeep);
        // Keep an even spread of what's left (so every side still feels it), drop the rest.
        this.queue = rest.filter((_, i) => Math.floor(((i + 1) * keep) / rest.length) > Math.floor((i * keep) / rest.length));
        this.qi = 0;
      }
      const cleared = this.qi >= this.queue.length && this.surgeAlive <= 0;
      if (cleared || c.tick - this.surgeStart >= this.ticks(S.maxSurge)) this.endSurge();
    }
    return earned;
  }

  /** Play `seconds` of siege instantly (headless bases). */
  runFor(seconds: number): void {
    const end = this.combat.tick + this.ticks(seconds);
    while (this.combat.tick < end) this.step();
  }

  /** Live zombies around the base per side (north, east, south, west), weighted by toughness and how close they are. */
  pressure(): [number, number, number, number] {
    const out: [number, number, number, number] = [0, 0, 0, 0];
    for (const u of this.combat.units) {
      if (u.state === 'dead') continue;
      const dx = u.x - this.hqX;
      const dy = u.y - this.hqY;
      const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
      const kind = UNIT_KINDS[u.kind];
      const weight = kind === 'z_big' ? 3 : kind === 'z_axe' ? 2 : 1;
      const close = Math.max(Math.abs(dx), Math.abs(dy)) < PLOT / 2 - 2 ? 2 : 1; // inside the walls counts double
      out[side] += weight * close;
    }
    return out;
  }

  // ---- director -------------------------------------------------------------------------------------

  private startSurge() {
    const S = CONFIG.siege;
    const c = this.combat;
    const d = this.director;
    this.n++;
    const ramp = this.rampOn && this.n <= S.ramp.length;
    const minutes = d.played / 60;
    let size: number;
    if (ramp) {
      // The scripted first minute. Surge 1 is always the same small, winnable size; later ones can only ease.
      size = S.ramp[this.n - 1]!.size;
      if (this.n > 1) size = Math.round(size * Math.min(1, d.pressure));
    } else {
      const z = S.size;
      const threat = z.base + z.perHq * (this.base.hq - 1) + z.perKill * firepower(this.base, this.boost);
      size = Math.round(threat * (1 + z.perMinute * Math.min(minutes, z.maxMinutes)) * d.pressure);
      size = Math.max(4, Math.min(z.max, size));
    }
    const pincer = !ramp && this.n >= (this.rampOn ? S.pincerFrom : 1) && size >= 8;

    // Sides: every side gets some; a pincer piles most of the surge onto 2-3 of them at the same moment.
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const mains = pincer ? order.slice(0, this.rng() < 0.5 ? 2 : 3) : [];
    const grave = Math.max(1, Math.round(size * S.graveyardShare));
    const counts = [0, 0, 0, 0, grave];
    let rest = size - grave;
    if (pincer) {
      const main = Math.min(rest, Math.round(size * S.pincerShare));
      for (let i = 0; i < main; i++) counts[mains[i % mains.length]!]!++;
      rest -= main;
      const others = order.filter((s) => !mains.includes(s));
      for (let i = 0; i < rest; i++) counts[others[i % others.length]!]!++;
    } else {
      for (let i = 0; i < rest; i++) counts[order[i % 4]!]!++;
    }

    const big = this.share('z_big', minutes);
    const axe = this.share('z_axe', minutes);
    const kindOf = (): ZombieKind => {
      const r = this.rng();
      return r < big ? 'z_big' : r < big + axe ? 'z_axe' : 'z_small';
    };
    const spawns: Spawn[] = [];
    counts.forEach((count, side) => {
      const burst = mains.includes(side) ? S.pincerBurst : S.spawnWindow;
      for (let i = 0; i < count; i++) {
        // The first of each side comes at once: zombies on every side from the first second.
        const at = c.tick + this.ticks(i === 0 ? this.rng() * 0.3 : this.rng() * burst);
        spawns.push({ ...this.spawnAt(side, kindOf(), at) });
      }
    });
    spawns.sort((a, b) => a.at - b.at);
    this.queue = spawns;
    this.qi = 0;
    this.phase = 'surge';
    this.surgeStart = c.tick;
    this.surgeAlive = 0;
    this.surgeKills = 0;
    this.surgeCoins = 0;
    this.eased = false;
    this.events.push({ type: 'surge', n: this.n, size, sides: counts, pincer });
  }

  /** Big/Axe share of a surge: grows with Main Tower level and minutes played. */
  private share(kind: 'z_big' | 'z_axe', minutes: number) {
    const m = CONFIG.siege.mix[kind];
    return Math.min(m.max, m.perHq * (this.base.hq - 1) + m.perMinute * minutes);
  }

  /** Where a zombie on `side` appears: off the edge (runs in), a crack in the yard, the manhole, or a grave. */
  private spawnAt(side: number, kind: ZombieKind, at: number): Spawn {
    const p = this.plot;
    if (side === GRAVEYARD_SIDE) {
      const g = this.graves[Math.floor(this.rng() * this.graves.length)]!;
      return { at, kind, x: g.x + 0.5, y: g.y + 0.85, rise: true };
    }
    const src = CONFIG.siege.sources;
    const m = this.manholes[side];
    let r = this.rng() * (src.edge + src.crack + (m ? src.manhole : 0));
    if (m && (r -= src.edge + src.crack) >= 0) return { at, kind, x: m.x + 0.5, y: m.y + 0.6, rise: true };
    r = this.rng();
    const crack = this.rng() < src.crack / (src.edge + src.crack);
    // Along the side, and how far out (negative = inside the plot: the yard between its edge and the walls).
    const along = crack ? 2.5 + r * (PLOT - 5) : 1.5 + r * (PLOT - 3);
    const out = crack ? -(0.5 + this.rng() * 1.1) : 0.4 + this.rng() * (this.edgeOut[side]! - 0.4);
    const [x, y] = side === 0 ? [p.x + along, p.y - out] : side === 1 ? [p.x + PLOT + out, p.y + along] : side === 2 ? [p.x + along, p.y + PLOT + out] : [p.x - out, p.y + along];
    return { at, kind, x, y, rise: crack };
  }

  private endSurge() {
    const S = CONFIG.siege;
    const d = this.director;
    const c = this.combat;
    d.surges++;
    d.held++;
    const t = this.target();
    d.pressure = Math.min(S.difficulty.max, d.pressure + (S.difficulty.down * (1 - t)) / t);
    this.events.push({ type: 'held', n: this.n, kills: this.surgeKills, coins: this.surgeCoins });
    this.queue = [];
    this.qi = 0;
    c.repair(S.repair);
    const ramp = this.rampOn && this.n <= S.ramp.length;
    const [lo, hi] = S.breather;
    this.phase = 'breather';
    this.until = c.tick + this.ticks(ramp ? S.ramp[this.n - 1]!.breather : lo + this.rng() * (hi - lo));
    this.nextTrickle = c.tick + this.ticks(S.trickleEvery);
  }

  private breach() {
    const S = CONFIG.siege;
    const d = this.director;
    const c = this.combat;
    this.breaches++;
    d.surges++;
    d.pressure = Math.max(S.difficulty.min, d.pressure - S.difficulty.down);
    this.events.push({ type: 'breach', n: this.n });
    c.killAll();
    c.repair(1);
    this.queue = [];
    this.qi = 0;
    this.phase = 'breather';
    this.until = c.tick + this.ticks(S.breach.breather);
    this.nextTrickle = this.until;
  }
}
