import type { PostType, ZombieKind } from './config.ts';

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
  base: BaseState;
}

/** Combat snapshot streamed to clients (compact on purpose). */
export interface Snapshot {
  /** Tick number. */
  t: number;
  /** Units: [id, kind index, x*16, y*16, hp 0-100, state (0 move 1 attack 2 dead), facing (1 right / -1 left)] */
  u: [number, number, number, number, number, number, number][];
  /** Buildings whose hp changed since the last snapshot: [id, hp 0-100] */
  b: [number, number][];
  /** Shots this period: [postId, x*16, y*16] (target position) */
  s: [number, number, number][];
}

export const UNIT_KINDS: ZombieKind[] = ['z_small', 'z_big', 'z_axe'];

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
}
