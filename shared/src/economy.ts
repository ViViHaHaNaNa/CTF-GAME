import { CONFIG, POST_TYPES, hqUpgradeCost, postUpgradeCost, slotsUnlocked, wallUpgradeCost, type PostType } from './config.ts';
import { SLOTS } from './layout.ts';
import type { BaseState } from './types.ts';

// Build/upgrade rules as pure functions. The server is the only one that applies them;
// the client uses `quote` to label buttons.

export type BaseAction =
  | { kind: 'hq' }
  | { kind: 'walls' }
  | { kind: 'build'; slot: number; type: PostType }
  | { kind: 'post'; slot: number };

export interface Quote {
  ok: boolean;
  cost: number;
  /** Why it can't be done (when !ok and it's not just about coins). */
  reason?: string;
}

export function newBase(): BaseState {
  const posts: BaseState['posts'] = SLOTS.map(() => null);
  posts[0] = { type: CONFIG.start.starterPost, level: 1 };
  return { hq: 1, walls: 1, posts };
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

/** The base after an action (call only after `quote(...).ok`). */
export function applyAction(base: BaseState, a: BaseAction): BaseState {
  const next: BaseState = { hq: base.hq, walls: base.walls, posts: base.posts.map((p) => (p ? { ...p } : null)) };
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
  }
  return next;
}

/** Parse an untrusted action from the network. */
export function parseAction(raw: unknown): BaseAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'hq' || r.kind === 'walls') return { kind: r.kind };
  if (r.kind === 'build' && typeof r.slot === 'number' && typeof r.type === 'string' && (POST_TYPES as readonly string[]).includes(r.type)) {
    return { kind: 'build', slot: r.slot, type: r.type as PostType };
  }
  if (r.kind === 'post' && typeof r.slot === 'number') return { kind: 'post', slot: r.slot };
  return null;
}
