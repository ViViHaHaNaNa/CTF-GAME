import { CONFIG } from './config.ts';
import type { BoostType, Boosts, Rarity } from './types.ts';

// Crate rules shared by server (authoritative) and client (labels only): answer checking,
// rarity rolls and how a crate's boost is granted.

export const RARITIES: Rarity[] = ['rare', 'epic', 'legendary'];
export const BOOST_TYPES: BoostType[] = ['attack', 'defence', 'loot'];
export const RARITY_COLOR: Record<Rarity, 'green' | 'blue' | 'red'> = { rare: 'green', epic: 'blue', legendary: 'red' };

export interface Question {
  id: string;
  prompt: string;
  code: string;
  lang: string;
  kind: string;
  answers: string[];
  difficulty: number;
}

/** Lenient comparison form: case, outer quotes/backticks, a trailing semicolon, commas and spacing don't matter. */
export function normaliseAnswer(raw: unknown): string {
  let s = String(raw ?? '').trim().toLowerCase();
  s = s.replace(/;+$/, '').trim();
  s = s.replace(/^[`"']+|[`"']+$/g, '').trim();
  s = s.replace(/;+$/, '').trim();
  return s.replace(/[\s,]+/g, ' ');
}

export function checkAnswer(q: Question, raw: unknown): boolean {
  const given = normaliseAnswer(raw);
  if (!given || given.length > 200) return false;
  return q.answers.some((a) => {
    const want = normaliseAnswer(a);
    // Fill-in-the-blank code: spacing inside tokens is a matter of style ("<= +=1" vs "<= += 1").
    return given === want || (q.kind === 'fill-blank' && given.replace(/ /g, '') === want.replace(/ /g, ''));
  });
}

/** `r` in [0, 1). */
export function rollRarity(r: number): Rarity {
  const w = CONFIG.crates.weights;
  const x = r * (w.rare + w.epic + w.legendary);
  return x < w.rare ? 'rare' : x < w.rare + w.epic ? 'epic' : 'legendary';
}

export function boostLabel(type: BoostType, pct: number): string {
  const p = `+${Math.round(pct * 100)}%`;
  if (type === 'attack') return `${p} raider damage (next ${CONFIG.crates.boosts.attack.uses} raids)`;
  if (type === 'defence') return `${p} post damage & health (${CONFIG.crates.boosts.defence.minutes} min)`;
  return `${p} loot (next raid)`;
}

/** Drop expired/used-up boosts. */
export function liveBoosts(b: Boosts, now: number): Boosts {
  const out: Boosts = {};
  if (b.attack && b.attack.uses > 0) out.attack = b.attack;
  if (b.defence && b.defence.until > now) out.defence = b.defence;
  if (b.loot && b.loot.uses > 0) out.loot = b.loot;
  return out;
}

export function currentPct(b: Boosts, type: BoostType, now: number): number {
  return liveBoosts(b, now)[type]?.pct ?? 0;
}

export interface Grant {
  boosts: Boosts;
  /** Set when a boost was given. */
  type?: BoostType;
  /** Coins paid instead (every eligible boost was already stronger). */
  coins: number;
  text: string;
}

/**
 * What a crate of `rarity` gives: a random boost type that isn't already active at a stronger level
 * (equal strength refreshes it). If none qualifies, consolation coins. `r` in [0, 1).
 */
export function grantCrate(boosts: Boosts, rarity: Rarity, now: number, r: number): Grant {
  const cfg = CONFIG.crates.boosts;
  const b = liveBoosts(boosts, now);
  const eligible = BOOST_TYPES.filter((t) => (b[t]?.pct ?? 0) <= cfg[t].pct[rarity]);
  if (!eligible.length) {
    const coins = CONFIG.crates.consolation[rarity];
    return { boosts: b, coins, text: `+${coins} coins` };
  }
  const type = eligible[Math.min(eligible.length - 1, Math.floor(r * eligible.length))]!;
  const pct = cfg[type].pct[rarity];
  const next: Boosts = { ...b };
  if (type === 'attack') next.attack = { pct, uses: cfg.attack.uses };
  else if (type === 'defence') next.defence = { pct, until: now + cfg.defence.minutes * 60_000 };
  else next.loot = { pct, uses: cfg.loot.uses };
  return { boosts: next, type, coins: 0, text: boostLabel(type, pct) };
}
