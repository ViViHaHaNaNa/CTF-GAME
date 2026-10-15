import { CONFIG, ZOMBIE_KINDS, postStats, type ZombieKind } from './config.ts';
import { Combat, mulberry32, type BuildingDef, type UnitStats } from './engine.ts';
import { GRID, HQ_RECT, SIDES, SLOTS, WALLS, type Side } from './layout.ts';
import type { BaseState, WaveSummary } from './types.ts';

// Zombie waves (PvE). A wave is fully described by the base, the HQ level and a seed, so the same
// inputs always play out the same way — online (streamed live) or offline (resolved headlessly).

export const HQ_ID = 1;
export const wallId = (i: number) => 100 + i;
export const postId = (slot: number) => 200 + slot;

/** Combat buildings for a base. Waves never cause permanent damage: every wave starts from this. */
export function baseBuildings(base: BaseState): BuildingDef[] {
  const defs: BuildingDef[] = [{ id: HQ_ID, kind: 'hq', ...HQ_RECT, hp: CONFIG.hq.hp(base.hq) }];
  const wallHp = CONFIG.walls.hp(base.walls);
  for (const w of WALLS) defs.push({ id: wallId(w.i), kind: 'wall', x: w.x, y: w.y, w: 1, h: 1, hp: wallHp });
  base.posts.forEach((p, slot) => {
    if (!p) return;
    const s = SLOTS[slot]!;
    const st = postStats(p.type, p.level);
    defs.push({ id: postId(slot), kind: 'post', x: s.x, y: s.y, w: 1, h: 1, hp: st.hp, gun: { range: st.range, damage: st.damage, cooldown: st.cooldown, splash: st.splash } });
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
  };
}

export function killCoins(kind: ZombieKind, hq: number): number {
  return Math.round(CONFIG.zombies[kind].coins * CONFIG.waves.coinScale(hq));
}

export interface PlannedSpawn {
  tick: number;
  kind: ZombieKind;
  x: number;
  y: number;
}

export interface WavePlan {
  sides: Side[];
  spawns: PlannedSpawn[];
}

/** Who comes, from where, and when. */
export function planWave(hq: number, seed: number): WavePlan {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const sideCount = 1 + Math.floor(rng() * CONFIG.waves.maxSides);
  const sides: Side[] = [];
  while (sides.length < sideCount) {
    const s = SIDES[Math.floor(rng() * SIDES.length)]!;
    if (!sides.includes(s)) sides.push(s);
  }
  const mix = CONFIG.waves.mix(hq);
  const total = mix.z_small + mix.z_big + mix.z_axe;
  const count = CONFIG.waves.count(hq);
  const spread = CONFIG.waves.spawnSpread * CONFIG.tickRate;
  const spawns: PlannedSpawn[] = [];
  for (let i = 0; i < count; i++) {
    const r = rng() * total;
    const kind: ZombieKind = r < mix.z_small ? 'z_small' : r < mix.z_small + mix.z_big ? 'z_big' : 'z_axe';
    const side = sides[i % sides.length]!;
    const along = 2 + rng() * (GRID - 4);
    const [x, y] = side === 'n' ? [along, 0.5] : side === 's' ? [along, GRID - 0.5] : side === 'w' ? [0.5, along] : [GRID - 0.5, along];
    spawns.push({ tick: Math.floor((i / count) * spread + rng() * CONFIG.tickRate), kind, x, y });
  }
  spawns.sort((a, b) => a.tick - b.tick);
  return { sides, spawns };
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

  constructor(readonly base: BaseState, readonly seed: number) {
    this.combat = new Combat(seed, baseBuildings(base));
    this.plan = planWave(base.hq, seed);
  }

  /** One tick. Returns coins earned by kills this tick. */
  step(): number {
    if (this.done) return 0;
    const c = this.combat;
    while (this.next < this.plan.spawns.length && this.plan.spawns[this.next]!.tick <= c.tick) {
      const s = this.plan.spawns[this.next++]!;
      c.addUnit(ZOMBIE_KINDS.indexOf(s.kind), zombieStats(s.kind, this.base.hq), s.x, s.y);
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

  /** Play to the end instantly (offline bases, disconnects). */
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
