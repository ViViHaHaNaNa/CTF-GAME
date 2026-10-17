import type { Mode, PostType } from './config.ts';

export type Rarity = 'rare' | 'epic' | 'legendary';
export type BoostType = 'attack' | 'defence' | 'loot';

/** Active crate boosts. Only one of each type; a stronger one replaces a weaker one. */
export interface Boosts {
  /** Extra raider damage for the next `uses` raids. */
  attack?: { pct: number; uses: number };
  /** Extra post damage and health until `until` (server ms). */
  defence?: { pct: number; until: number };
  /** Extra loot from the next raid. */
  loot?: { pct: number; uses: number };
}

/** The current global crate as every client sees it (never includes the answers while unclaimed). */
export interface CrateView {
  id: number;
  rarity: Rarity;
  prompt: string;
  code: string;
  lang: string;
  kind: string;
  spawnedAt: number;
  /** Server ms when it expires (= when the next crate drops). */
  expiresAt: number;
  claimedBy?: string;
  /** What the winner got. */
  reward?: string;
  /** Revealed once claimed. */
  answer?: string;
}

// Persistent base state (what the server stores per player).

export interface PostState {
  type: PostType;
  level: number;
}

export interface BaseState {
  hq: number;
  walls: number;
  /** One entry per slot; null = empty. */
  posts: (PostState | null)[];
  /** Commander weapon: index into COMMANDER_WEAPONS (missing on older saves = 0, the pistol). */
  cmd?: number;
  /** The weapon's upgrade level (missing = 1; a new weapon starts at 1). */
  cmdLv?: number;
}

/** A player's surge pause (server-side, saved with the player). 'pending': waiting for the current surge to end. */
export interface PauseState {
  state: 'pending' | 'paused';
  /** Server ms when a pause that has taken hold resumes on its own (0 while pending). */
  until: number;
}

/** What the client is told about its own player. */
export interface PlayerView {
  id: number;
  name: string;
  roll: string;
  coins: number;
  trophies: number;
  plot: number;
  base: BaseState;
  /** Server time (ms) until which this base can't be raided. */
  shieldUntil: number;
  /** Server time (ms) until which this player bought immunity from raids. */
  immuneUntil: number;
  boosts: Boosts;
  /** Grind (pve) or Raid (pvp). */
  mode: Mode;
  /** Server ms of the last mode switch (the cooldown runs from here). */
  modeAt: number;
  /** Surges paused (or pausing after this surge); null = running. */
  pause: PauseState | null;
  /** Server ms until which a new pause can't start (after the last one ended). */
  pauseCooldownUntil: number;
}

/** Combat snapshot streamed to clients (compact on purpose). Positions are world pixels. */
export interface Snapshot {
  /** Tick number. */
  t: number;
  /** Units: [id, kind index (UNIT_KINDS), x*16, y*16, hp 0-100, state (0 move 1 attack 2 dead 3 rise), facing (1 right / -1 left)] */
  u: [number, number, number, number, number, number, number][];
  /** Buildings whose hp changed since the last snapshot: [id, hp 0-100] */
  b: [number, number][];
  /** Shots this period: [shooter id (post 200+slot, or a unit id), x*16, y*16] (target position) */
  s: [number, number, number][];
}

/**
 * One claimed base in the world summary every client receives (kept tiny: ~64 of these).
 * Wave states: 0 calm/headless, 1 warning (zombies about to rise), 2 wave on.
 */
export interface BaseSummary {
  /** Plot id. */
  p: number;
  /** Player id. */
  id: number;
  name: string;
  hq: number;
  walls: number;
  /** Per slot: [post type index, level] or null. */
  posts: ([number, number] | null)[];
  /** Commander weapon index. */
  cmd: number;
  trophies: number;
  /** Server ms until which the base can't be raided (0 = not shielded). */
  shield: number;
  /** Raid in progress against this base (0 = none). */
  /** Server ms until which bought immunity lasts (0 = none). */
  immune: number;
  raid: number;
  /** Name of the raider, when raid != 0. */
  raider?: string;
  wave: 0 | 1 | 2;
  /** Coins a full raid could take right now (before the match factor). */
  loot: number;
  /** The owner's mode: grinding zombies or out raiding. */
  mode: Mode;
  /** Grinding with a (nearly) full vault: the juiciest target. */
  vaultFull: boolean;
  /** Surges paused on this base (shown on the map). */
  paused?: boolean;
}

export interface RaidStatus {
  id: number;
  plot: number;
  attackerId: number;
  attacker: string;
  defender: string;
  /** 0..100 (Main Tower, posts and vault; walls don't count) */
  destruction: number;
  /** Stars earned so far (0..3). */
  stars: number;
  /** The vault has been cracked. */
  vault: boolean;
  deployed: number;
  /** Raiders the attacker can still send (by the troop limit; coins permitting). */
  armyLeft: number;
}

/** Why a raid ended. 'cancelled' = nothing was deployed: no cost, no reward, no shield. */
export type RaidEndReason = 'cleared' | 'army' | 'ended' | 'stall' | 'cancelled' | 'failsafe';

export interface RaidResult {
  id: number;
  plot: number;
  attacker: string;
  defender: string;
  /** 1+ stars. */
  won: boolean;
  stars: number;
  reason: RaidEndReason;
  destruction: number;
  /** The vault was cracked. */
  vault: boolean;
  loot: number;
  trophies: number;
  spent: number;
}

export interface FeedItem {
  t: number;
  text: string;
  kind: 'raid' | 'join' | 'rank' | 'info' | 'crate';
}

export interface WaveSummary {
  breached: boolean;
  kills: number;
  coins: number;
  lost: number;
}

export interface OfflineSummary {
  waves: number;
  breaches: number;
  coinsEarned: number;
  coinsLost: number;
  /** Coins that didn't fit in the offline bank. */
  capped: boolean;
  /** Raids against this base while away. */
  raids?: number;
  raidLosses?: number;
}
