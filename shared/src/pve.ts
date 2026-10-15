import { CONFIG, UNIT_KINDS, ZOMBIE_KINDS, postStats, type ZombieKind } from './config.ts';
import { Combat, mulberry32, type BuildingDef, type UnitStats } from './engine.ts';
import { HQ_RECT, SLOTS, WALLS } from './layout.ts';
import type { BaseState, WaveSummary } from './types.ts';
import { getWorld, type WorldPlot } from './world.ts';

// Zombie waves (PvE). A wave is fully described by the base, its plot and a seed, so the same inputs
// always play out the same way: online (streamed live) or offline (resolved headlessly).
// Zombies rise from the graves of the base's own graveyard and only ever attack that base.

export const HQ_ID = 1;
export const wallId = (i: number) => 100 + i;
export const postId = (slot: number) => 200 + slot;

/** A base's buildings placed on its plot (world tiles). Every fight starts from this: no lasting damage. */
export function baseBuildings(base: BaseState, plot: { x: number; y: number }, defenceBoost = 0): BuildingDef[] {
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
    defs.push({ id: postId(slot), kind: 'post', x: ox + s.x, y: oy + s.y, w: 1, h: 1, hp: Math.round(st.hp * boost), gun: { range: st.range, damage: Math.round(st.damage * boost), cooldown: st.cooldown, splash: st.splash } });
  });
  return defs;
}

export function zombieStats(kind: ZombieKind, hq: number): UnitStats {
  const z = CONFIG.zombies[kind];
  return {
    hp: Math.round(z.hp * CONFIG.waves.hpScale(hq)),
    speed: z.speed,
    damage: Math.round(z.damage * CONFIG.waves.damageScale(hq)),
    cooldown: z.cooldown,
    range: z.range,
    wallMult: z.wallMult,
    target: 'hq',
  };
}

export function killCoins(kind: ZombieKind, hq: number): number {
  return Math.round(CONFIG.zombies[kind].coins * CONFIG.waves.coinScale(hq));
}

export interface PlannedSpawn {
  tick: number;
  kind: ZombieKind;
  /** World tile (centre of a grave). */
  x: number;
  y: number;
}

export interface WavePlan {
  graveyard: number;
  spawns: PlannedSpawn[];
}

/** Who rises, from which grave, and when. */
export function planWave(hq: number, seed: number, plot: WorldPlot): WavePlan {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const gy = getWorld().graveyards[plot.graveyard]!;
  const mix = CONFIG.waves.mix(hq);
  const total = mix.z_small + mix.z_big + mix.z_axe;
  const count = CONFIG.waves.count(hq);
  const spread = CONFIG.waves.spawnSpread * CONFIG.tickRate;
  const start = Math.floor(rng() * gy.graves.length);
  const spawns: PlannedSpawn[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng() * total;
    const kind: ZombieKind = r < mix.z_small ? 'z_small' : r < mix.z_small + mix.z_big ? 'z_big' : 'z_axe';
    const grave = gy.graves[(start + i) % gy.graves.length]!;
    spawns.push({ tick: Math.floor((i / count) * spread + rng() * CONFIG.tickRate), kind, x: grave.x + 0.5, y: grave.y + 0.85 });
  }
  spawns.sort((a, b) => a.tick - b.tick);
  return { graveyard: gy.id, spawns };
}

/** A running zombie wave on top of the shared combat engine. */
export class ZombieWave {
  readonly combat: Combat;
  readonly plan: WavePlan;
  private next = 0;
  kills = 0;
  coins = 0;
  done = false;
  breached = false;

  /** `defenceBoost`: extra post damage/health from a crate boost (0.25 = +25%). */
  constructor(readonly base: BaseState, readonly seed: number, readonly plot: WorldPlot, defenceBoost = 0) {
    this.combat = new Combat(seed, baseBuildings(base, plot, defenceBoost));
    this.plan = planWave(base.hq, seed, plot);
  }

  /** One tick. Returns coins earned by kills this tick. */
  step(): number {
    if (this.done) return 0;
    const c = this.combat;
    const rise = Math.round(CONFIG.waves.riseTime * CONFIG.tickRate);
    while (this.next < this.plan.spawns.length && this.plan.spawns[this.next]!.tick <= c.tick) {
      const s = this.plan.spawns[this.next++]!;
      c.addUnit(UNIT_KINDS.indexOf(s.kind), zombieStats(s.kind, this.base.hq), s.x, s.y, rise);
    }
    const r = c.step();
    let earned = 0;
    for (const k of r.kills) earned += killCoins(ZOMBIE_KINDS[k.kind]!, this.base.hq);
    this.kills += r.kills.length;
    this.coins += earned;
    if (c.hqDestroyed) {
      this.breached = true;
      this.done = true;
    } else if ((this.next >= this.plan.spawns.length && c.liveUnits === 0) || c.tick >= CONFIG.waves.maxDuration * CONFIG.tickRate) {
      this.done = true;
    }
    return earned;
  }

  /** Play to the end instantly (offline bases, unwatched bases, disconnects). */
  runToEnd(): void {
    while (!this.done) this.step();
  }
}

/** Coins lost to a breach: a capped share, never dropping the player below the protected floor. */
export function breachLoss(coins: number): number {
  const b = CONFIG.waves.breach;
  return Math.max(0, Math.min(coins - b.protectedFloor, Math.round(coins * b.lossPct), b.maxLoss));
}

export function summarize(w: ZombieWave, coinsBefore: number): WaveSummary {
  return { breached: w.breached, kills: w.kills, coins: w.coins, lost: w.breached ? breachLoss(coinsBefore + w.coins) : 0 };
}
