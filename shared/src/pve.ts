import { COMMANDER_WEAPONS, CONFIG, UNIT_KINDS, postStats, type ZombieKind } from './config.ts';
import { Combat, mulberry32, type BuildingDef, type StepResult, type Unit, type UnitStats } from './engine.ts';
import { HQ_RECT, PLOT, SLOTS, VAULT_RECT, WALLS } from './layout.ts';
import type { BaseState } from './types.ts';
import { basicBaseDone } from './economy.ts';
import { getWorld, sideTile, type WorldPlot } from './world.ts';

// Zombie defence (PvE): one siege per grinding base. Surges come on a regular, visible countdown that
// grows with the Main Tower level (no trickle in between). Early play is guided: a new player's first
// surge is a walkthrough from one side that can't be lost; until level 3 surges are small, from 1-2
// sides, announced for the whole countdown. Sides (1 -> all 4 + the graveyard), zombie types (Big at 3,
// Axe at 4, a boss from 6), size and gap all grow with level. The player can call a surge early for
// coins. A director nudges size to keep a target share held. Zombies only ever attack their own base.
//
// Everything is decided by the base, its plot, a seed and the director's state, so a siege plays out
// the same way online (streamed live) or headless (offline bases, resolved at a coarse tick rate).

export const HQ_ID = 1;
export const VAULT_ID = 2;
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
  const defs: BuildingDef[] = [
    { id: HQ_ID, kind: 'hq', x: ox + HQ_RECT.x, y: oy + HQ_RECT.y, w: HQ_RECT.w, h: HQ_RECT.h, hp: CONFIG.hq.hp(base.hq) },
    { id: VAULT_ID, kind: 'vault', x: ox + VAULT_RECT.x, y: oy + VAULT_RECT.y, w: VAULT_RECT.w, h: VAULT_RECT.h, hp: CONFIG.vault.hp(base.hq) },
  ];
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

/** A zombie's stats; `toughness` (from the ramp, 1 = as listed) multiplies its health and damage. */
export function zombieStats(kind: ZombieKind, toughness = 1): UnitStats {
  const z = CONFIG.zombies[kind];
  return {
    hp: Math.round(z.hp * toughness),
    speed: z.speed * CONFIG.pace.zombieSpeed,
    damage: Math.round(z.damage * toughness),
    cooldown: z.cooldown * CONFIG.pace.zombieCooldown,
    range: z.range,
    wallMult: z.wallMult,
    target: 'hq',
    radius: z.radius,
  };
}

/** Coins for a kill: the zombie's power x its toughness x coins per power. */
export function killCoins(kind: ZombieKind, toughness = 1): number {
  return Math.max(1, Math.round(CONFIG.siege.power[kind] * toughness * CONFIG.siege.coinsPerPower));
}

/** The ramp's surge power (in Smalls) at ramp multiplier `ramp`, how many power units go to numbers, and the toughness on top. */
export function surgePower(ramp: number): { power: number; count: number; toughness: number } {
  const R = CONFIG.siege.ramp;
  const r = Math.max(0.3, ramp);
  const countMult = Math.min(r, R.countCap);
  return { power: R.start * r, count: R.start * countMult, toughness: r / countMult };
}

/** How much stronger the next surge is than the last, after `surges` surges: tapering from `growth` to `growthLate`. */
export function rampGrowth(surges: number): number {
  const R = CONFIG.siege.ramp;
  return R.growth + (R.growthLate - R.growth) * Math.min(1, surges / R.taperOver);
}

/** The threat meter's Defence: the posts' damage per second (with any defence boost) x CONFIG.siege.defencePerDps. */
export function defenceRating(base: BaseState, defenceBoost = 0): number {
  return Math.round(postDps(base, defenceBoost) * CONFIG.siege.defencePerDps);
}

/** Firepower: how many Smalls per second a base's posts can shoot down (splash counts as hitting a few). */
export function firepower(base: BaseState, defenceBoost = 0): number {
  const hp = zombieStats('z_small').hp;
  let kills = 0;
  for (const p of base.posts) {
    if (!p) continue;
    const st = postStats(p.type, p.level);
    const shots = Math.ceil(hp / Math.round(st.damage * (1 + defenceBoost)));
    kills += (1 / st.cooldown / shots) * (st.splash > 0 ? 2.5 : 1);
  }
  return kills;
}

/** Coins lost to a breach: a capped share of the vault (cap by Main Tower level), never dropping the player below the protected floor. */
export function breachLoss(coins: number, hq = 1): number {
  const b = CONFIG.siege.breach;
  const cap = b.maxLoss[Math.min(b.maxLoss.length, Math.max(1, hq)) - 1]!;
  return Math.max(0, Math.min(coins - b.protectedFloor, Math.round(coins * b.lossPct), cap));
}

/** What the siege remembers about a player between sessions (saved with the player). */
export interface DirectorState {
  /** The difficulty ramp: the next surge's strength multiplier (1 = the first surges). Only ever grows. */
  ramp: number;
  /** Seconds of siege played while online. */
  played: number;
  surges: number;
  held: number;
}

export function newDirector(): DirectorState {
  return { ramp: 1, played: 0, surges: 0, held: 0 };
}

export type SiegeEvent =
  | { type: 'surge'; n: number; size: number; sides: number[]; pincer: boolean; tutorial: boolean; boss: boolean; horde: boolean }
  | { type: 'held'; n: number; kills: number; coins: number; bonus: number; dead: number; secs: number }
  | { type: 'breach'; n: number; dead: number; secs: number }
  /** The surge ran long: the rest are enraged. */
  | { type: 'rage'; n: number }
  /** An airstrike landed. */
  | { type: 'strike'; x: number; y: number; kills: number; coins: number };

// ---- the Commander (tap-to-attack) -----------------------------------------------------------------------

/** Where the Commander stands on a plot (world tiles, at the feet): just below the Main Tower's right end. */
export function commanderSpot(plot: { x: number; y: number }): [number, number] {
  return [plot.x + HQ_RECT.x + HQ_RECT.w - 0.5, plot.y + HQ_RECT.y + HQ_RECT.h + 0.9];
}

/** Can a tap at world tile (x, y) be aimed at this plot's siege? Within `reach` tiles of the plot. */
export function inTapReach(plot: WorldPlot, x: number, y: number): boolean {
  const r = CONFIG.commander.reach;
  return x >= plot.x - r && y >= plot.y - r && x < plot.x + PLOT + r && y < plot.y + PLOT + r;
}

/** Is world tile (x, y) inside some other base's plot? (A tap there opens that base, unless one of your zombies is under it.) */
export function inOtherPlot(plot: WorldPlot, x: number, y: number): boolean {
  for (const o of getWorld().plots) if (o.id !== plot.id && x >= o.x && y >= o.y && x < o.x + PLOT && y < o.y + PLOT) return true;
  return false;
}

/** The posts' combined damage per second (the tap cap is a share of this). */
export function postDps(base: BaseState, defenceBoost = 0): number {
  let dps = 0;
  for (const p of base.posts) {
    if (!p) continue;
    const st = postStats(p.type, p.level);
    dps += Math.round(st.damage * (1 + defenceBoost)) / st.cooldown;
  }
  return dps;
}

/** Most tap damage per second this base allows (a share of its posts' DPS, with a floor; attack boosts lift it). */
export function tapDpsCap(base: BaseState, defenceBoost = 0, attackBoost = 0): number {
  const c = CONFIG.commander.dpsCap;
  return Math.max(c.floor, c.share * postDps(base, defenceBoost)) * (1 + attackBoost);
}

export function commanderWeapon(base: BaseState) {
  return CONFIG.commander.weapons[COMMANDER_WEAPONS[base.cmd ?? 0] ?? 'pistol'];
}

/** A resolved tap: every screen watching the base draws it. */
export interface TapResult {
  ok: true;
  /** Where the shot went (its target, or the tap point on a miss), world tiles. */
  x: number;
  y: number;
  /** Each pellet that hit: [x, y, damage, 1 if it killed]. */
  hits: [number, number, number, number][];
  kills: number;
  /** Coins from tap kills, combo bonus included. */
  coins: number;
  bonus: number;
  combo: number;
  mult: number;
  /** Rounds left, and seconds of reload left (0 = not reloading). */
  mag: number;
  reload: number;
  weapon: number;
}

export interface TapRefused {
  ok: false;
  error: 'reloading' | 'too fast';
  mag: number;
  reload: number;
}

export type AirstrikeResult = { ok: true; x: number; y: number; delay: number; ready: number } | { ok: false; error: string; ready: number };

export interface SiegeOptions {
  /** Extra post damage/health from a crate boost (0.25 = +25%). */
  defenceBoost?: number;
  /** Headless resolution at a coarse tick rate (offline bases). */
  coarse?: boolean;
  /** May run the walkthrough first surge for a player who has never had one (default true; headless runs don't). */
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
  /** The coming (or current) surge's sides: 0 north, 1 east, 2 south, 3 west, 4 graveyard. */
  incoming: number[] = [];
  /** The coming (or current) surge is the walkthrough. */
  tutorial: boolean;
  /** Still building the basic base: gentler ramp, one side, prompts. */
  guided: boolean;
  /** The current surge's toughness (health, damage and coins per zombie). */
  private toughness = 1;
  /** The coming surge's power (picked with its sides, shown on the threat meter) and whether it's a horde. */
  private nextPower = 0;
  private nextHorde = false;
  private base: BaseState;
  private boost: number;
  private queue: Spawn[] = [];
  private qi = 0;
  /** queue[0..assigned) have spawn times (released pulses); the rest wait for the field to thin out. */
  private assigned = 0;
  private pulseAt = 0;
  private lastPulse = 0;
  private raging = false;
  /** Ticks this surge spent with nobody on the field (it should be ~0: the next pulse comes when the field thins). */
  private deadTicks = 0;
  /** Dead time of every surge so far, for the debug log and the balance scripts (seconds). */
  deadLog: number[] = [];
  private surgeStart = 0;
  private surgeAlive = 0;
  private surgeKills = 0;
  private surgeCoins = 0;

  /** How far out the edge spawns may be on each side (street: further than an alley). */
  private readonly edgeOut: number[];
  private readonly manholes: ({ x: number; y: number } | null)[];
  private readonly graves: { x: number; y: number }[];
  private readonly hqX: number;
  private readonly hqY: number;
  /** The Commander's gun: rounds, reload, fire-rate gate, damage budget, combo, airstrike cooldown (ticks). */
  private gun = { weapon: -1, mag: 0, reloadUntil: 0, nextShot: 0, budget: 0, budgetAt: -1, combo: 0, comboAt: 0, airReady: 0 };
  private strikes: { x: number; y: number; at: number }[] = [];

  constructor(base: BaseState, readonly plot: WorldPlot, seed: number, readonly director: DirectorState, opts: SiegeOptions = {}) {
    this.base = base;
    this.boost = opts.defenceBoost ?? 0;
    this.combat = new Combat(seed, baseBuildings(base, plot, opts.defenceBoost ?? 0, true), { crowd: true, coarse: opts.coarse, stuckAfter: CONFIG.siege.stuckAfter });
    this.rng = mulberry32(seed ^ 0x9e3779b9);
    this.tutorial = (opts.ramp ?? true) && director.surges === 0;
    this.guided = !basicBaseDone(base);
    director.ramp ??= 1;
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
    this.planIncoming();
  }

  private ticks(seconds: number) {
    return Math.round(seconds * this.combat.rate);
  }

  /** Count kills made outside the engine's tick or inside it: coins, and the current surge's tally. */
  private account(kills: StepResult['kills']): number {
    let earned = 0;
    for (const k of kills) {
      const coins = killCoins(UNIT_KINDS[k.kind] as ZombieKind, this.toughness);
      earned += coins;
      if (this.phase === 'surge' && k.tag === this.n) {
        this.surgeAlive--;
        this.surgeKills++;
        this.surgeCoins += coins;
      }
    }
    this.kills += kills.length;
    this.coins += earned;
    return earned;
  }

  /** Fill the magazine when the reload is done (or the weapon changed). */
  private gunReady() {
    const g = this.gun;
    const w = commanderWeapon(this.base);
    if (g.weapon !== (this.base.cmd ?? 0)) {
      g.weapon = this.base.cmd ?? 0;
      g.mag = w.magazine;
      g.reloadUntil = 0;
    }
    if (g.reloadUntil && this.combat.tick >= g.reloadUntil) {
      g.mag = w.magazine;
      g.reloadUntil = 0;
    }
  }

  /** Rounds left and reload seconds left, for the ammo bar. */
  ammo(): { mag: number; reload: number; weapon: number; airIn: number; combo: number } {
    this.gunReady();
    const g = this.gun;
    const t = this.combat.tick;
    const combo = t - g.comboAt > this.ticks(CONFIG.commander.combo.timeout) ? 0 : g.combo;
    return { mag: g.mag, reload: g.reloadUntil ? (g.reloadUntil - t) / this.combat.rate : 0, weapon: g.weapon, airIn: Math.max(0, (g.airReady - t) / this.combat.rate), combo };
  }

  /** Start a reload now (an "R" press or a tap on the ammo bar), unless the magazine is full. */
  reload() {
    this.gunReady();
    const g = this.gun;
    const w = commanderWeapon(this.base);
    if (g.reloadUntil || g.mag >= w.magazine) return;
    g.reloadUntil = this.combat.tick + this.ticks(w.reload);
  }

  /**
   * The Commander fires at a tap (world tiles). The target is the zombie closest to the tap point within
   * the hit radius; with none there the shot flies on toward the point and hits the first zombie close
   * to its path. Fire rate, magazine, reload and the damage cap are enforced here, on the server.
   */
  tap(x: number, y: number, attackBoost = 0): TapResult | TapRefused {
    const C = CONFIG.commander;
    const c = this.combat;
    const t = c.tick;
    this.gunReady();
    const g = this.gun;
    const w = commanderWeapon(this.base);
    const refuse = (error: TapRefused['error']): TapRefused => ({ ok: false, error, mag: g.mag, reload: g.reloadUntil ? (g.reloadUntil - t) / c.rate : 0 });
    if (g.reloadUntil) return refuse('reloading');
    if (t < g.nextShot - C.rateSlackTicks) return refuse('too fast');
    g.nextShot = t + Math.max(1, Math.round(c.rate / w.fireRate));
    g.mag--;
    if (g.mag <= 0) {
      g.mag = 0;
      g.reloadUntil = t + this.ticks(w.reload);
    }

    // Damage budget: refills at the cap rate; a shot beyond it hits softer.
    const cap = tapDpsCap(this.base, this.boost, attackBoost);
    g.budget = g.budgetAt < 0 ? cap * C.dpsCap.burst : Math.min(cap * C.dpsCap.burst, g.budget + (cap * (t - g.budgetAt)) / c.rate);
    g.budgetAt = t;
    const want = w.damage * (1 + attackBoost) * w.pellets;
    const scale = Math.min(1, g.budget / want);
    g.budget = Math.max(0, g.budget - want * scale);
    const per = Math.max(1, Math.round(w.damage * (1 + attackBoost) * scale));

    let victims: Unit[] = [];
    let tx = x;
    let ty = y;
    // Aim assist in the walkthrough surge only.
    const near = c.unitsNear(x, y, this.tutorial ? C.hitRadiusGuided : C.hitRadius);
    if (near.length) {
      const target = near[0]!;
      tx = target.x;
      ty = target.y;
      victims.push(target);
      if (w.pellets > 1) {
        // Spread: the other pellets go to the zombies nearest the target (doubling up if there are few).
        const around = c.unitsNear(target.x, target.y, w.spread);
        for (let i = 1; i < w.pellets; i++) victims.push(around.length ? around[i % around.length]! : target);
      }
    } else {
      const stray = this.alongShot(x, y);
      if (stray) victims = Array.from({ length: w.pellets }, () => stray);
    }
    const kills: StepResult['kills'] = [];
    const hits: TapResult['hits'] = [];
    for (const v of victims) {
      if (v.state === 'dead') continue;
      const killed = c.strike(v, per, kills);
      hits.push([v.x, v.y, per, killed ? 1 : 0]);
    }

    // Combo: kills in a row build it, a shot that hits nothing resets it.
    if (t - g.comboAt > this.ticks(C.combo.timeout)) g.combo = 0;
    if (kills.length) g.combo += kills.length;
    else if (!hits.length) g.combo = 0;
    g.comboAt = t;
    const mult = Math.min(C.combo.max, 1 + Math.floor(g.combo / C.combo.step));
    const base = this.account(kills);
    const bonus = kills.length ? base * (mult - 1) : 0;
    this.coins += bonus;
    return { ok: true, x: tx, y: ty, hits, kills: kills.length, coins: base + bonus, bonus, combo: g.combo, mult, mag: g.mag, reload: g.reloadUntil ? (g.reloadUntil - t) / c.rate : 0, weapon: g.weapon };
  }

  /** A shot at empty ground flies from the Commander toward the point: the first zombie close to that path takes it. */
  private alongShot(x: number, y: number): Unit | undefined {
    const [cx, cy] = commanderSpot(this.plot);
    const ox = cx;
    const oy = cy - 0.6;
    const dx = x - ox;
    const dy = y - oy;
    const len = Math.hypot(dx, dy) || 1;
    const r = CONFIG.commander.strayRadius;
    let best: Unit | undefined;
    let bestT = Infinity;
    for (const u of this.combat.unitsNear((ox + x) / 2, (oy + y) / 2, len / 2 + r)) {
      const along = ((u.x - ox) * dx + (u.y - oy) * dy) / len;
      if (along < 0 || along > len + r) continue;
      const off = Math.abs((u.x - ox) * dy - (u.y - oy) * dx) / len;
      if (off <= r && along < bestT) (best = u), (bestT = along);
    }
    return best;
  }

  /** Call an airstrike on a spot (world tiles): it lands after a short warning. */
  airstrike(x: number, y: number): AirstrikeResult {
    const A = CONFIG.commander.airstrike;
    const t = this.combat.tick;
    const g = this.gun;
    if (t < g.airReady) return { ok: false, error: 'Airstrike not ready', ready: (g.airReady - t) / this.combat.rate };
    g.airReady = t + this.ticks(A.cooldown);
    this.strikes.push({ x, y, at: t + this.ticks(A.delay) });
    return { ok: true, x, y, delay: A.delay, ready: A.cooldown };
  }

  /** Airstrikes whose warning is up: everything in the blast takes the hit. */
  private landStrikes(): number {
    if (!this.strikes.length) return 0;
    const A = CONFIG.commander.airstrike;
    let earned = 0;
    const t = this.combat.tick;
    this.strikes = this.strikes.filter((s) => {
      if (s.at > t) return true;
      const kills: StepResult['kills'] = [];
      const dmg = Math.round(A.damage * this.toughness);
      for (const u of this.combat.unitsNear(s.x, s.y, A.radius)) this.combat.strike(u, dmg, kills);
      const coins = this.account(kills);
      earned += coins;
      this.events.push({ type: 'strike', x: s.x, y: s.y, kills: kills.length, coins });
      return false;
    });
    return earned;
  }

  /** The base changed (an upgrade, a new post): it joins the fight right away. */
  setBase(base: BaseState, defenceBoost = 0) {
    this.base = base;
    this.boost = defenceBoost;
    // Guidance ends for good once the basic base is built.
    if (this.guided && basicBaseDone(base)) {
      this.guided = false;
      if (this.phase !== 'surge') this.planIncoming();
    }
    this.combat.setBuildings(baseBuildings(base, this.plot, defenceBoost, true));
  }

  /** Seconds until the next surge (0 while one is on). */
  nextIn(): number {
    return this.phase === 'surge' ? 0 : Math.max(0, (this.until - this.combat.tick) / this.combat.rate);
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
    if (this.phase === 'surge') {
      // The next pulse comes as soon as the field thins out (or after a while), never on a fixed clock.
      const P = S.pulse;
      const pending = this.assigned - this.qi;
      const thin = this.surgeAlive <= Math.floor(this.lastPulse * P.refillBelow);
      if (this.assigned < this.queue.length && pending === 0 && (thin || c.tick - this.pulseAt >= this.ticks(P.maxWait))) this.releasePulse();
      // Running long: the rest enrage and everything left comes at once.
      if (!this.raging && c.tick - this.surgeStart >= this.ticks(S.rage.after)) {
        this.raging = true;
        while (this.assigned < this.queue.length) this.releasePulse();
        for (const u of c.units) if (u.state !== 'dead') u.stats = this.enrage(u.stats);
        this.events.push({ type: 'rage', n: this.n });
      }
    }
    // Never an empty field while zombies are waiting: bring the next one in now.
    if (this.phase === 'surge' && c.liveUnits === 0 && this.qi < this.assigned) this.queue[this.qi]!.at = c.tick;
    while (this.qi < this.assigned && this.queue[this.qi]!.at <= c.tick && c.liveUnits < S.maxAlive) {
      const s = this.queue[this.qi++]!;
      const stats = zombieStats(s.kind, this.toughness);
      c.addUnit(UNIT_KINDS.indexOf(s.kind), this.raging ? this.enrage(stats) : stats, s.x, s.y, s.rise ? rise : 0, this.n);
      this.surgeAlive++;
    }

    let earned = this.landStrikes() + this.held;
    this.held = 0;
    const r = c.step();
    earned += this.account(r.kills);

    if (c.hqDestroyed) {
      this.breach();
      return earned;
    }
    if (this.phase === 'surge') {
      // The surge ends the moment everything has spawned and died; the countdown starts right then.
      const cleared = this.qi >= this.queue.length && this.surgeAlive <= 0;
      if (cleared || c.tick - this.surgeStart >= this.ticks(S.maxSurge)) this.endSurge();
      else if (c.liveUnits === 0) this.deadTicks++;
    }
    return earned;
  }

  /** Faster and angrier (a surge that ran too long). */
  private enrage(stats: UnitStats): UnitStats {
    const R = CONFIG.siege.rage;
    return { ...stats, speed: stats.speed * R.speed, cooldown: stats.cooldown * R.cooldown };
  }

  /** Let the next pulse of the surge in: it lands over a few seconds, the first one at once. */
  private releasePulse() {
    const S = CONFIG.siege;
    const c = this.combat;
    const size = this.tutorial ? S.tutorial.pulse : this.guided ? S.guided.pulse : this.byLevel(S.pulse.size);
    const end = Math.min(this.queue.length, this.assigned + size);
    for (let i = this.assigned; i < end; i++) this.queue[i]!.at = c.tick + (i === this.assigned ? 0 : this.ticks(this.rng() * S.pulse.spread));
    const slice = this.queue.slice(this.assigned, end).sort((a, b) => a.at - b.at);
    for (let i = 0; i < slice.length; i++) this.queue[this.assigned + i] = slice[i]!;
    this.lastPulse = end - this.assigned;
    this.assigned = end;
    this.pulseAt = c.tick;
  }

  /** Seconds of the current (or last) surge spent with nobody on the field. */
  deadTime(): number {
    return this.deadTicks / this.combat.rate;
  }

  /** Play one whole surge instantly, from now to its end (headless bases). Returns the seconds it took. */
  runSurge(): number {
    const c = this.combat;
    const t0 = c.tick;
    const limit = t0 + this.ticks(CONFIG.siege.maxSurge + 90);
    const n = this.n;
    while (c.tick < limit && !(this.n > n && this.phase === 'breather')) this.step();
    return (c.tick - t0) / c.rate;
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
      const weight = kind === 'z_boss' ? 10 : kind === 'z_big' ? 3 : kind === 'z_axe' ? 2 : 1;
      const close = Math.max(Math.abs(dx), Math.abs(dy)) < PLOT / 2 - 2 ? 2 : 1; // inside the walls counts double
      out[side] += weight * close;
    }
    return out;
  }

  // ---- director -------------------------------------------------------------------------------------

  /** A value from a per-level table (index = Main Tower level - 1). */
  private byLevel<T>(table: readonly T[]): T {
    return table[Math.min(table.length, Math.max(1, this.base.hq)) - 1]!;
  }

  /** Pick the sides of the coming surge (shown while the countdown runs). Sides unlock with level. */
  private planIncoming() {
    const S = CONFIG.siege;
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    // The coming surge's strength: the ramp (capped while guided), a little variety, and every so often a horde.
    const R = S.ramp;
    const ramp = this.guided ? Math.min(this.director.ramp, S.guided.maxRamp) : this.director.ramp;
    this.nextHorde = !this.tutorial && !this.guided && (this.director.surges + 1) % S.hordeEvery === 0;
    const vary = 1 + S.variance * (2 * this.rng() - 1);
    this.nextPower = this.tutorial ? S.tutorial.size : R.start * Math.min(R.max, ramp) * vary * (this.nextHorde ? S.hordeMult : 1);
    const sides = order.slice(0, this.tutorial ? 1 : Math.min(this.byLevel(S.sides), this.guided ? S.guided.maxSides : 4));
    if (!this.tutorial && !this.guided && this.base.hq >= S.graveyardFrom) sides.push(GRAVEYARD_SIDE);
    this.incoming = sides.sort((x, y) => x - y);
  }

  /** What a screen shows about this siege: surge number, phase, countdown, incoming sides, walkthrough. */
  /** The threat meter: the base's Defence and the next surge's power (x toughness), in the same units. */
  threat(): { defence: number; next: number; horde: boolean } {
    return { defence: defenceRating(this.base, this.boost), next: Math.round(this.nextPower), horde: this.nextHorde };
  }

  info() {
    const E = CONFIG.siege.callEarly;
    const left = this.nextIn();
    // When "call early" opens (seconds from now; 0 = now) and what it would pay right now.
    const opensIn = this.phase === 'surge' ? -1 : Math.max(0, left - this.byLevel(CONFIG.siege.gap) * (1 - E.minWait));
    const early = this.phase !== 'surge' && opensIn === 0 && left >= E.minLeft ? Math.round(left * this.byLevel(E.perSecond)) : 0;
    return { n: this.n, phase: this.phase, nextIn: Math.ceil(left), incoming: this.incoming, tutorial: this.tutorial, guided: this.guided, early, earlyOpensIn: Math.ceil(opensIn), ...this.threat(), toughness: this.toughness, surges: this.director.surges };
  }

  /**
   * Start the next surge now instead of waiting out the countdown: pays coins for every second skipped
   * (none with less than `minLeft` to go). Returns the bonus, 0 if it can't be called now.
   */
  callEarly(): number {
    const E = CONFIG.siege.callEarly;
    if (this.phase === 'surge') return 0;
    const left = (this.until - this.combat.tick) / this.combat.rate;
    if (left < E.minLeft || left > this.byLevel(CONFIG.siege.gap) * (1 - E.minWait) + 1e-6) return 0;
    this.until = this.combat.tick;
    return Math.round(left * this.byLevel(E.perSecond));
  }

  private startSurge() {
    const S = CONFIG.siege;
    const c = this.combat;
    const d = this.director;
    this.n++;
    const tutorial = this.tutorial;
    // Spend the planned power: numbers first (up to the count cap), then toughness.
    const ramp = surgePower(this.nextPower / S.ramp.start);
    this.toughness = tutorial ? 1 : ramp.toughness;
    const sides = this.incoming.filter((s) => s !== GRAVEYARD_SIDE);
    const graveyard = this.incoming.includes(GRAVEYARD_SIDE);
    const pincer = !tutorial && this.base.hq >= S.pincerFrom && sides.length >= 3;
    const mains = pincer ? sides.slice(0, this.rng() < 0.5 ? 2 : 3) : [];

    // Spend the surge's power on zombies (types unlocked by the Main Tower), then share them out over its sides.
    const big = tutorial ? 0 : this.byLevel(S.mix.z_big);
    const axe = tutorial ? 0 : this.byLevel(S.mix.z_axe);
    const kindOf = (): ZombieKind => {
      const r = this.rng();
      return r < big ? 'z_big' : r < big + axe ? 'z_axe' : 'z_small';
    };
    const boss = !tutorial && this.rng() < this.byLevel(S.bossChance) && ramp.count > S.power.z_boss * 1.5;
    let budget = tutorial ? S.tutorial.size : ramp.count - (boss ? S.power.z_boss : 0);
    const kinds: ZombieKind[] = [];
    while (budget > 0.5) {
      const k = kindOf();
      kinds.push(k);
      budget -= S.power[k];
    }
    const size = kinds.length;
    const counts = [0, 0, 0, 0, 0];
    let rest = size;
    if (graveyard) {
      counts[GRAVEYARD_SIDE] = Math.max(1, Math.round(size * S.graveyardShare));
      rest -= counts[GRAVEYARD_SIDE]!;
    }
    if (pincer) {
      const main = Math.round(rest * S.pincerShare);
      for (let i = 0; i < main; i++) counts[mains[i % mains.length]!]!++;
      rest -= main;
      const others = sides.filter((s) => !mains.includes(s));
      for (let i = 0; i < rest; i++) counts[(others.length ? others : mains)[i % (others.length || mains.length)]!]!++;
    } else {
      for (let i = 0; i < rest; i++) counts[sides[i % sides.length]!]!++;
    }

    // The surge is a list of zombies, mixed across its sides; it's let in pulse by pulse (releasePulse).
    const spawns: Spawn[] = [];
    counts.forEach((count, side) => {
      for (let i = 0; i < count; i++) spawns.push(this.spawnAt(side, kinds.pop() ?? 'z_small', Infinity));
    });
    for (let i = spawns.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [spawns[i], spawns[j]] = [spawns[j]!, spawns[i]!];
    }
    // The boss walks in with the middle of the surge.
    if (boss) spawns.splice(Math.floor(spawns.length / 2), 0, { ...this.spawnAt(sides[Math.floor(this.rng() * sides.length)]!, 'z_boss', Infinity), rise: false });
    this.queue = spawns;
    this.qi = 0;
    this.assigned = 0;
    this.raging = false;
    this.deadTicks = 0;
    this.phase = 'surge';
    this.surgeStart = c.tick;
    this.releasePulse();
    this.surgeAlive = 0;
    this.surgeKills = 0;
    this.surgeCoins = 0;
    // The walkthrough can't be lost.
    const hq = c.hq;
    if (hq) hq.floor = tutorial ? Math.round(hq.maxHp * S.tutorial.hqFloor) : undefined;
    this.events.push({ type: 'surge', n: this.n, size: spawns.length, sides: counts, pincer, tutorial, boss, horde: this.nextHorde });
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

  /** Between surges: repair, then a regular countdown (by level) to the next one, whose sides are picked now. */
  private countdown() {
    const S = CONFIG.siege;
    const c = this.combat;
    this.queue = [];
    this.qi = 0;
    this.assigned = 0;
    c.repair(S.repair);
    const hq = c.hq;
    if (hq) hq.floor = undefined;
    this.tutorial = false;
    this.phase = 'breather';
    this.until = c.tick + this.ticks(this.byLevel(S.gap));
    this.planIncoming();
  }

  /** After every live surge the ramp grows (gently while guided), whatever happened in it. */
  private advance() {
    const R = CONFIG.siege.ramp;
    const d = this.director;
    d.surges++;
    if (this.counting && !this.tutorial) d.ramp = Math.min(R.max, d.ramp * rampGrowth(d.surges));
  }

  private endSurge() {
    const S = CONFIG.siege;
    this.director.held++;
    // Holding a surge pays a bonus in proportion to its power.
    const bonus = this.tutorial ? S.tutorial.bonus : Math.round(this.nextPower * S.holdPerPower);
    this.held += bonus;
    this.coins += bonus;
    this.deadLog.push(this.deadTime());
    this.events.push({ type: 'held', n: this.n, kills: this.surgeKills, coins: this.surgeCoins + bonus, bonus, dead: this.deadTime(), secs: (this.combat.tick - this.surgeStart) / this.combat.rate });
    this.advance();
    this.countdown();
  }

  /** Surge-hold bonuses not yet collected by the caller (step() returns them with the kill coins). */
  private held = 0;

  private breach() {
    this.breaches++;
    this.deadLog.push(this.deadTime());
    this.events.push({ type: 'breach', n: this.n, dead: this.deadTime(), secs: (this.combat.tick - this.surgeStart) / this.combat.rate });
    this.combat.killAll();
    this.combat.repair(1);
    this.advance();
    this.countdown();
  }
}
