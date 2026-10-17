import { COMMANDER_WEAPONS, CONFIG, RAIDER_KINDS, type CommanderWeapon, type RaiderKind } from './config.ts';
import type { UnitStats } from './engine.ts';
import type { BaseState } from './types.ts';

// The player's powers, unlocked by the Main Tower: the Commander's weapons (each with its own upgrade
// levels), the abilities (airstrike, molotov, squad member, ultimate), and the raider roster. The same
// roster serves PvP raids and the squad member in your siege, so one unlock path covers both modes.

export type AbilityId = 'airstrike' | 'molotov' | 'squad' | 'ultimate';
export const ABILITIES: readonly AbilityId[] = ['airstrike', 'molotov', 'squad', 'ultimate'];

/** A power and when it unlocks (its name, icon and description are UI copy: client/src/siege/copy.ts). */
export interface PowerInfo {
  id: CommanderWeapon | AbilityId;
  kind: 'weapon' | 'ability';
  unlockHq: number;
}

const C = CONFIG.commander;

/** Every power past the starting pistol, in unlock order. */
export const POWERS: PowerInfo[] = (
  [
    { id: 'gun', kind: 'weapon', unlockHq: C.weapons.gun.unlockHq },
    { id: 'airstrike', kind: 'ability', unlockHq: C.airstrike.unlockHq },
    { id: 'shotgun', kind: 'weapon', unlockHq: C.weapons.shotgun.unlockHq },
    { id: 'molotov', kind: 'ability', unlockHq: C.molotov.unlockHq },
    { id: 'squad', kind: 'ability', unlockHq: C.squad.unlockHq },
    { id: 'ultimate', kind: 'ability', unlockHq: C.ultimate.unlockHq },
  ] as PowerInfo[]
).sort((a, b) => a.unlockHq - b.unlockHq);

export function abilityUnlocked(hq: number, id: AbilityId): boolean {
  return hq >= C[id].unlockHq;
}

/** Powers that a Main Tower upgrade to `hq` unlocks (for the "New power unlocked!" moment). */
export function powersUnlockedAt(hq: number): PowerInfo[] {
  return POWERS.filter((p) => p.unlockHq === hq);
}

/** The Commander's weapon level (1 = as bought). */
export function weaponLevel(base: BaseState): number {
  return Math.max(1, Math.min(C.weaponLevels.max, base.cmdLv ?? 1));
}

/** The Commander's current weapon with its upgrade level applied. */
export function commanderWeapon(base: BaseState) {
  const name = COMMANDER_WEAPONS[base.cmd ?? 0] ?? 'pistol';
  return weaponStats(name, weaponLevel(base));
}

export function weaponStats(name: CommanderWeapon, level: number) {
  const w = C.weapons[name];
  const L = C.weaponLevels;
  const k = level - 1;
  return {
    ...w,
    name,
    level,
    damage: Math.round(w.damage * (1 + L.damage * k)),
    magazine: Math.round(w.magazine * (1 + L.magazine * k)),
    reload: Math.round(w.reload * (1 - L.reload * k) * 100) / 100,
    /** Multiplies the tap damage cap. */
    capMult: 1 + L.damage * k,
  };
}

// ---- the raider roster (raids and the squad member) --------------------------------------------------

export function raiderStats(kind: RaiderKind, attackerHq: number, attackBoost = 0): UnitStats {
  const r = CONFIG.pvp.raiders[kind];
  const k = CONFIG.pvp.troopScale(attackerHq);
  const pace = CONFIG.pace;
  return { hp: Math.round(r.hp * k), speed: r.speed * pace.raiderSpeed, damage: Math.round(r.damage * k * (1 + attackBoost)), cooldown: r.cooldown * pace.raiderCooldown, range: r.range, wallMult: r.wallMult, target: 'nearest' };
}

/** What a raider costs an attacker at Main Tower level `hq`. */
export function raiderCost(kind: RaiderKind, hq: number): number {
  const s = CONFIG.pvp.costScale;
  return Math.round(CONFIG.pvp.raiders[kind].cost * s[Math.min(s.length, Math.max(1, hq)) - 1]!);
}

export function raiderUnlocked(kind: RaiderKind, hq: number): boolean {
  return hq >= CONFIG.pvp.raiders[kind].unlockHq;
}

export function isRaiderKind(k: unknown): k is RaiderKind {
  return typeof k === 'string' && (RAIDER_KINDS as readonly string[]).includes(k);
}

/** A squad member: the raider at your level, sturdier and harder hitting (they fight a whole surge). */
export function squadStats(kind: RaiderKind, hq: number): UnitStats {
  const s = raiderStats(kind, hq);
  const Q = C.squad;
  return { ...s, hp: Math.round(s.hp * Q.hpMult), damage: Math.round(s.damage * Q.damageMult) };
}
