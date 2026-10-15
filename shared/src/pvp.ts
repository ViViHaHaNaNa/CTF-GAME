import { CONFIG, RAIDER_KINDS, UNIT_KINDS, type RaiderKind } from './config.ts';
import { Combat, type UnitStats } from './engine.ts';
import { inDeployZone } from './layout.ts';
import { baseBuildings } from './pve.ts';
import type { BaseState } from './types.ts';

// PvP raids, Clash-of-Clans style, on the same combat engine as the zombie waves.
// The defender's posts fight automatically; the attacker deploys raiders on the apron outside the walls.

export function raiderStats(kind: RaiderKind, attackerHq: number, attackBoost = 0): UnitStats {
  const r = CONFIG.pvp.raiders[kind];
  const k = CONFIG.pvp.troopScale(attackerHq);
  return { hp: Math.round(r.hp * k), speed: r.speed, damage: Math.round(r.damage * k * (1 + attackBoost)), cooldown: r.cooldown, range: r.range, wallMult: r.wallMult, target: 'nearest' };
}

export function raiderUnlocked(kind: RaiderKind, hq: number): boolean {
  return hq >= CONFIG.pvp.raiders[kind].unlockHq;
}

export function isRaiderKind(k: unknown): k is RaiderKind {
  return typeof k === 'string' && (RAIDER_KINDS as readonly string[]).includes(k);
}

export type RaidEnd = 'hq' | 'destruction' | 'time' | 'retreat' | 'idle';

export class Raid {
  readonly combat: Combat;
  deployed = 0;
  done = false;
  won = false;
  endReason: RaidEnd | null = null;
  private lastDeployTick = 0;

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

  get ticksLeft(): number {
    return Math.max(0, CONFIG.pvp.duration * CONFIG.tickRate - this.combat.tick);
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
    this.lastDeployTick = this.combat.tick;
  }

  retreat() {
    this.finish('retreat');
  }

  step(): void {
    if (this.done) return;
    const c = this.combat;
    c.step();
    if (c.hqDestroyed) return this.finish('hq');
    if (c.destruction() >= CONFIG.pvp.winDestruction) return this.finish('destruction');
    if (this.ticksLeft === 0) return this.finish('time');
    const idle = c.tick - this.lastDeployTick > CONFIG.pvp.idleEnd * CONFIG.tickRate;
    if (idle && c.liveUnits === 0) this.finish('idle');
  }

  private finish(reason: RaidEnd) {
    this.done = true;
    this.endReason = reason;
    this.won = this.combat.hqDestroyed || this.combat.destruction() >= CONFIG.pvp.winDestruction;
  }
}

/** Loot a win takes from a defender with `coins`, before the weaker-target factor. */
export function lootable(coins: number, defenderHq: number): number {
  const l = CONFIG.pvp.loot;
  return Math.max(0, Math.min(coins - l.protectedFloor, Math.round(coins * l.pct), l.capBase + l.capPerHq * defenderHq));
}

/** 1 for fair fights; shrinks when the defender has far fewer trophies than the attacker. */
export function weakerFactor(attackerTrophies: number, defenderTrophies: number): number {
  const w = CONFIG.pvp.weaker;
  const gap = attackerTrophies - defenderTrophies;
  if (gap <= 0) return 1;
  return Math.max(w.min, 1 - gap / w.span);
}

/** Trophies the attacker would win (and the defender lose) on a successful raid. */
export function trophyStake(attackerTrophies: number, defenderTrophies: number): number {
  const t = CONFIG.pvp.trophies;
  const raw = t.base + (defenderTrophies - attackerTrophies) * t.perDiff;
  return Math.round(Math.max(t.min, Math.min(t.max, raw)) * weakerFactor(attackerTrophies, defenderTrophies) || t.min);
}
