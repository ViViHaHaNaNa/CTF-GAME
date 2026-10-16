import { CONFIG, RAIDER_KINDS, UNIT_KINDS, type RaiderKind } from './config.ts';
import { Combat, type UnitStats } from './engine.ts';
import { inDeployZone } from './layout.ts';
import { VAULT_ID, baseBuildings } from './pve.ts';
import type { BaseState, RaidEndReason } from './types.ts';

// PvP raids, Clash-of-Clans style, on the same combat engine as the zombie waves.
// The defender's posts fight automatically; the attacker deploys raiders on the apron outside the walls.

export function raiderStats(kind: RaiderKind, attackerHq: number, attackBoost = 0): UnitStats {
  const r = CONFIG.pvp.raiders[kind];
  const k = CONFIG.pvp.troopScale(attackerHq);
  const pace = CONFIG.pace;
  return { hp: Math.round(r.hp * k), speed: r.speed * pace.raiderSpeed, damage: Math.round(r.damage * k * (1 + attackBoost)), cooldown: r.cooldown * pace.raiderCooldown, range: r.range, wallMult: r.wallMult, target: 'nearest' };
}

export function raiderUnlocked(kind: RaiderKind, hq: number): boolean {
  return hq >= CONFIG.pvp.raiders[kind].unlockHq;
}

export function isRaiderKind(k: unknown): k is RaiderKind {
  return typeof k === 'string' && (RAIDER_KINDS as readonly string[]).includes(k);
}

/** Stars for a raid: 1 for destroying CONFIG.pvp.stars.destruction of what counts, 1 for the Main Tower, 1 for everything. */
export function raidStars(destruction: number, hqDown: boolean): number {
  return (destruction >= CONFIG.pvp.stars.destruction ? 1 : 0) + (hqDown ? 1 : 0) + (destruction >= 1 ? 1 : 0);
}

/** Loot from what was destroyed: `fromVault` of the stake for the vault, the rest in proportion to destruction. */
export function raidLoot(stake: number, destruction: number, vaultDown: boolean): number {
  const f = CONFIG.pvp.loot.fromVault;
  return Math.round(stake * ((1 - f) * destruction + f * (vaultDown ? 1 : 0)));
}

/** Coins a raid's stars pay on top of the loot (new coins): per star, by the defender's level, x the match factor. */
export function starBonus(stars: number, defenderHq: number, match = 1): number {
  const t = CONFIG.pvp.loot.starBonus;
  return Math.round(stars * t[Math.min(t.length, Math.max(1, defenderHq)) - 1]! * match);
}

/** Trophies for the attacker: a win pays stars/3 of the stake (at least the minimum), a 0-star raid costs a share of it. */
export function raidTrophies(stake: number, stars: number): number {
  const t = CONFIG.pvp.trophies;
  return stars > 0 ? Math.max(t.min, Math.round((stake * stars) / 3)) : -Math.round(stake * t.lossFactor);
}

/**
 * A raid has no countdown. It ends when everything that counts is destroyed, when every raider is dead
 * and the attacker can't send more, or when they end it. Anti-stall rules end it too (no damage for a
 * while after the first deploy; nothing deployed at all, which cancels it) and a hidden failsafe caps it.
 */
export class Raid {
  readonly combat: Combat;
  deployed = 0;
  done = false;
  won = false;
  stars = 0;
  endReason: RaidEndReason | null = null;
  private firstDeployTick = -1;

  constructor(
    readonly id: number,
    readonly plot: { id: number; x: number; y: number },
    readonly defenderBase: BaseState,
    readonly attackerHq: number,
    seed: number,
    /** Crate boosts: extra raider damage, and the defender's extra post damage/health. */
    readonly boosts: { attack?: number; defence?: number } = {},
  ) {
    this.combat = new Combat(seed, baseBuildings(defenderBase, plot, boosts.defence ?? 0));
  }

  /** Validate and place a raider at a world position (tile units). The caller charges the coins. */
  canDeploy(kind: RaiderKind, x: number, y: number): string | null {
    if (this.done) return 'The raid is over';
    if (!raiderUnlocked(kind, this.attackerHq)) return `Needs Main Tower level ${CONFIG.pvp.raiders[kind].unlockHq}`;
    if (this.deployed >= CONFIG.pvp.maxDeploys) return 'Troop limit reached';
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Bad position';
    if (!inDeployZone(Math.floor(x - this.plot.x), Math.floor(y - this.plot.y))) return 'Deploy outside the walls, inside the plot';
    return null;
  }

  deploy(kind: RaiderKind, x: number, y: number): void {
    this.combat.addUnit(UNIT_KINDS.indexOf(kind), raiderStats(kind, this.attackerHq, this.boosts.attack ?? 0), x, y);
    this.deployed++;
    if (this.firstDeployTick < 0) this.firstDeployTick = this.combat.tick;
  }

  /** The attacker taps End attack: rewards from whatever is destroyed so far. */
  end() {
    if (!this.done) this.finish('ended');
  }

  /** Share of what counts (Main Tower, posts, vault) destroyed, 0..1. */
  destruction(): number {
    return this.combat.destruction();
  }

  vaultDown(): boolean {
    return this.combat.buildings.get(VAULT_ID)?.alive === false;
  }

  /** Stars as things stand. */
  currentStars(): number {
    return raidStars(this.destruction(), this.combat.hqDestroyed);
  }

  /**
   * One tick. `armyLeft`: can the attacker still send a raider (troop limit and coins)? The server
   * knows the coins; by default only the troop limit counts.
   */
  step(armyLeft = this.deployed < CONFIG.pvp.maxDeploys): void {
    if (this.done) return;
    const c = this.combat;
    const S = CONFIG.pvp.stall;
    const r = c.rate;
    c.step();
    if (this.destruction() >= 1) return this.finish('cleared');
    if (this.deployed > 0 && c.liveUnits === 0 && !armyLeft) return this.finish('army');
    if (this.deployed > 0 && c.tick - Math.max(this.firstDeployTick, c.lastHitTick) >= S.noDamage * r) return this.finish('stall');
    if (this.deployed === 0 && c.tick >= S.noDeploy * r) return this.finish('cancelled');
    if (c.tick >= S.failsafe * r) this.finish('failsafe');
  }

  private finish(reason: RaidEndReason) {
    this.done = true;
    this.endReason = reason;
    this.stars = reason === 'cancelled' ? 0 : this.currentStars();
    this.won = this.stars > 0;
  }
}

/** The loot stake against a defender with `coins` (a full-destruction raid with the vault takes all of it), before the weaker-target factor. */
export function lootable(coins: number, defenderHq: number): number {
  const l = CONFIG.pvp.loot;
  return Math.max(0, Math.min(coins - l.protectedFloor, Math.round(coins * l.pct), l.capBase + l.capPerHq * defenderHq));
}

/**
 * How much a raid pays, from the trophy gap and the Main Tower gap: 1 for an even fight, down to a
 * fraction against much weaker bases, more against stronger ones. Multiplies loot and trophies.
 */
export function matchFactor(attackerTrophies: number, defenderTrophies: number, attackerHq: number, defenderHq: number): number {
  const m = CONFIG.pvp.match;
  const gap = (defenderTrophies - attackerTrophies) / m.span;
  const byTrophies = gap >= 0 ? Math.min(m.max, 1 + gap * (m.max - 1)) : Math.max(m.min, 1 + gap * (1 - m.min));
  const byLevel = Math.max(m.levelMin, Math.min(m.levelMax, 1 + m.perLevel * (defenderHq - attackerHq)));
  return byTrophies * byLevel;
}

/** Trophies a 3-star raid wins (and the defender loses): the base stake scaled by the match factor, within min..max. */
export function trophyStake(attackerTrophies: number, defenderTrophies: number, attackerHq = 1, defenderHq = 1): number {
  const t = CONFIG.pvp.trophies;
  return Math.round(Math.max(t.min, Math.min(t.max, t.base * matchFactor(attackerTrophies, defenderTrophies, attackerHq, defenderHq))));
}
