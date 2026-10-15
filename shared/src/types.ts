import type { PostType } from './config.ts';

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
  trophies: number;
  /** Server ms until which the base can't be raided (0 = not shielded). */
  shield: number;
  /** Raid in progress against this base (0 = none). */
  raid: number;
  /** Name of the raider, when raid != 0. */
  raider?: string;
  wave: 0 | 1 | 2;
  /** Coins a winning raid could take right now (before the weaker-target reduction). */
  loot: number;
}

export interface RaidStatus {
  id: number;
  plot: number;
  attackerId: number;
  attacker: string;
  defender: string;
  /** Seconds left. */
  left: number;
  /** 0..100 */
  destruction: number;
  deployed: number;
}

export interface RaidResult {
  id: number;
  plot: number;
  attacker: string;
  defender: string;
  won: boolean;
  destruction: number;
  loot: number;
  trophies: number;
  spent: number;
}

export interface FeedItem {
  t: number;
  text: string;
  kind: 'raid' | 'join' | 'rank' | 'info';
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
