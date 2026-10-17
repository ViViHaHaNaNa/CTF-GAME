import { COMMANDER_WEAPONS, CONFIG, POST_TYPES, hqUpgradeCost, postUpgradeCost, slotsUnlocked, wallUpgradeCost, type PostType } from './config.ts';
import { SLOTS } from './layout.ts';
import type { BaseState } from './types.ts';

// Build/upgrade rules as pure functions. The server is the only one that applies them;
// the client uses `quote` to label buttons.

export type BaseAction =
  | { kind: 'hq' }
  | { kind: 'walls' }
  | { kind: 'build'; slot: number; type: PostType }
  | { kind: 'post'; slot: number }
  /** Arm the Commander with the next weapon. */
  | { kind: 'commander' }
  /** Upgrade the Commander's current weapon one level. */
  | { kind: 'cmdUp' };

export interface Quote {
  ok: boolean;
  cost: number;
  /** Why it can't be done (when !ok and it's not just about coins). */
  reason?: string;
}

export function newBase(): BaseState {
  const posts: BaseState['posts'] = SLOTS.map(() => null);
  posts[0] = { type: CONFIG.start.starterPost, level: 1 };
  return { hq: 1, walls: 1, posts, cmd: 0, cmdLv: 1 };
}

/** What an action costs and whether the base allows it (coins are checked separately). */
export function quote(base: BaseState, a: BaseAction): Quote {
  switch (a.kind) {
    case 'hq': {
      const cost = hqUpgradeCost(base.hq);
      return cost === null ? { ok: false, cost: 0, reason: 'Main Tower is max level' } : { ok: true, cost };
    }
    case 'walls': {
      if (base.walls >= CONFIG.walls.maxLevel) return { ok: false, cost: 0, reason: 'Walls are max level' };
      if (base.walls >= base.hq) return { ok: false, cost: wallUpgradeCost(base.walls), reason: `Needs Main Tower level ${base.walls + 1}` };
      return { ok: true, cost: wallUpgradeCost(base.walls) };
    }
    case 'build': {
      if (!Number.isInteger(a.slot) || a.slot < 0 || a.slot >= SLOTS.length) return { ok: false, cost: 0, reason: 'No such slot' };
      if (a.slot >= slotsUnlocked(base.hq)) return { ok: false, cost: 0, reason: 'Slot locked: upgrade the Main Tower' };
      if (base.posts[a.slot]) return { ok: false, cost: 0, reason: 'Slot already has a post' };
      if (!POST_TYPES.includes(a.type)) return { ok: false, cost: 0, reason: 'Unknown post' };
      const need = CONFIG.hq.postUnlock[a.type];
      const cost = CONFIG.posts.types[a.type].build;
      if (base.hq < need) return { ok: false, cost, reason: `Needs Main Tower level ${need}` };
      return { ok: true, cost };
    }
    case 'commander': {
      const next = COMMANDER_WEAPONS[(base.cmd ?? 0) + 1];
      if (!next) return { ok: false, cost: 0, reason: 'Best weapon already' };
      const w = CONFIG.commander.weapons[next];
      if (base.hq < w.unlockHq) return { ok: false, cost: w.cost, reason: `Needs Main Tower level ${w.unlockHq}` };
      return { ok: true, cost: w.cost };
    }
    case 'cmdUp': {
      const name = COMMANDER_WEAPONS[base.cmd ?? 0] ?? 'pistol';
      const lv = base.cmdLv ?? 1;
      const L = CONFIG.commander.weaponLevels;
      if (lv >= L.max) return { ok: false, cost: 0, reason: 'Weapon is max level' };
      return { ok: true, cost: L.cost[name][lv - 1]! };
    }
    case 'post': {
      const p = base.posts[a.slot];
      if (!p) return { ok: false, cost: 0, reason: 'Empty slot' };
      if (p.level >= CONFIG.posts.maxLevel) return { ok: false, cost: 0, reason: 'Post is max level' };
      const cost = postUpgradeCost(p.type, p.level);
      if (p.level >= base.hq) return { ok: false, cost, reason: `Needs Main Tower level ${p.level + 1}` };
      return { ok: true, cost };
    }
  }
}

/**
 * The basic base: guidance (gentler surges, one side, prompts) runs until every item is done, then
 * ends for good. All read straight from the base, so nothing extra needs saving.
 */
export const BASIC_BASE: { id: string; label: string; done: (b: BaseState) => boolean }[] = [
  { id: 'post', label: 'Buy your first post', done: (b) => b.posts.filter(Boolean).length >= 2 },
  { id: 'slots', label: 'Fill both starter post slots', done: (b) => b.posts.slice(0, CONFIG.hq.slotsUnlocked[0]).every(Boolean) },
  { id: 'hq', label: 'Upgrade the Main Tower to level 2', done: (b) => b.hq >= 2 },
  { id: 'postUp', label: 'Upgrade a post', done: (b) => b.posts.some((p) => !!p && p.level >= 2) },
  { id: 'walls', label: 'Upgrade the walls', done: (b) => b.walls >= 2 },
];

export function basicBaseDone(b: BaseState): boolean {
  return BASIC_BASE.every((i) => i.done(b));
}

/** Coins a vault holds at a Main Tower level. */
export function vaultCapacity(hq: number): number {
  const c = CONFIG.vault.capacity;
  return c[Math.min(c.length, Math.max(1, hq)) - 1]!;
}

/** The base after an action (call only after `quote(...).ok`). */
export function applyAction(base: BaseState, a: BaseAction): BaseState {
  const next: BaseState = { hq: base.hq, walls: base.walls, posts: base.posts.map((p) => (p ? { ...p } : null)), cmd: base.cmd ?? 0, cmdLv: base.cmdLv ?? 1 };
  switch (a.kind) {
    case 'hq':
      next.hq++;
      break;
    case 'walls':
      next.walls++;
      break;
    case 'build':
      next.posts[a.slot] = { type: a.type, level: 1 };
      break;
    case 'post':
      next.posts[a.slot]!.level++;
      break;
    case 'commander':
      next.cmd = (next.cmd ?? 0) + 1;
      next.cmdLv = 1;
      break;
    case 'cmdUp':
      next.cmdLv = (next.cmdLv ?? 1) + 1;
      break;
  }
  return next;
}

/** Parse an untrusted action from the network. */
export function parseAction(raw: unknown): BaseAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'hq' || r.kind === 'walls' || r.kind === 'commander' || r.kind === 'cmdUp') return { kind: r.kind };
  if (r.kind === 'build' && typeof r.slot === 'number' && typeof r.type === 'string' && (POST_TYPES as readonly string[]).includes(r.type)) {
    return { kind: 'build', slot: r.slot, type: r.type as PostType };
  }
  if (r.kind === 'post' && typeof r.slot === 'number') return { kind: 'post', slot: r.slot };
  return null;
}
