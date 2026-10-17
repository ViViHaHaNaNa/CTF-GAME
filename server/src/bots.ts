import { COMMANDER_WEAPONS, CONFIG, POST_TYPES, SLOTS, newDirector, rampGrowth, slotsUnlocked, vaultCapacity, type BaseState, type DirectorState, type Mode, type PostType } from '@siege/shared';
import type { GameServer } from './game.ts';
import type { PlayerRecord } from './store.ts';

// Development bot accounts (DEV_MODE only): one per Main Tower level, so designers see every stage
// of the game on the map and in the UI. They're ordinary accounts nobody plays: raidable,
// spectatable, on the leaderboard, their surges resolve in the background like any offline player.
//
// Logins (name / roll number): Bot Lv1 / BOT01 ... Bot Lv8 / BOT08.

export const BOT_ROLL = /^BOT0[1-8]$/;
export const botName = (level: number) => `Bot Lv${level}`;
export const botRoll = (level: number) => `BOT0${level}`;

const DAY = 24 * 3600 * 1000;
/** Trophies by level, so the leaderboard has a spread. */
const TROPHIES = [0, 40, 120, 260, 480, 750, 1100, 1600];
/** Surges a steady player has behind them on reaching each level (from the balance bots). */
const SURGES = [2, 6, 14, 21, 27, 35, 44, 56];

/** A base fully built for its Main Tower level: every unlocked slot filled, posts and walls at the level, the best weapon. */
export function botBase(level: number): BaseState {
  const unlocked = POST_TYPES.filter((t) => CONFIG.hq.postUnlock[t] <= level);
  const posts = SLOTS.map((_, slot) => {
    if (slot >= slotsUnlocked(level)) return null;
    // A mix of the post types this level has: shotguns every third slot, guns in between.
    const want: PostType = slot % 3 === 2 ? 'shotgun' : slot % 3 === 1 ? 'gun' : 'pistol';
    const type = unlocked.includes(want) ? want : (unlocked.at(-1) ?? 'pistol');
    return { type, level: Math.min(level, CONFIG.posts.maxLevel) };
  });
  let cmd = 0;
  COMMANDER_WEAPONS.forEach((w, i) => {
    if (CONFIG.commander.weapons[w].unlockHq <= level) cmd = i;
  });
  return { hq: level, walls: Math.min(level, CONFIG.walls.maxLevel), posts, cmd, cmdLv: level >= 7 ? 3 : level >= 4 ? 2 : 1 };
}

/** The difficulty a player of this level would have reached. */
function botDirector(level: number): DirectorState {
  const surges = SURGES[level - 1]!;
  let ramp = 1;
  for (let n = 1; n <= surges; n++) ramp = Math.min(CONFIG.siege.ramp.max, ramp * rampGrowth(n));
  return { ...newDirector(), surges, held: Math.round(surges * 0.8), ramp };
}

/** Each bot's state: mode, coins, trophies, and a few with something special to show. */
function botState(level: number, now: number): Partial<PlayerRecord> {
  const mode: Mode = level % 2 === 0 ? 'pvp' : 'pve';
  const p: Partial<PlayerRecord> = {
    base: botBase(level),
    // Most of a vault: enough to try upgrades at that level.
    coins: Math.round(vaultCapacity(level) * 0.8),
    trophies: TROPHIES[level - 1]!,
    mode,
    modeAt: 0,
    siege: botDirector(level),
    boosts: {},
    immuneUntil: 0,
    shieldUntil: 0,
    pause: undefined,
    pauseCooldownUntil: 0,
  };
  // Lv3: an active boost (an attack boost lasts until its raids are used, and bots don't raid).
  if (level === 3) p.boosts = { attack: { pct: 0.25, uses: 3 } };
  // Lv4: immune to raids for a day (the shield chip on the map and in the top bar).
  if (level === 4) p.immuneUntil = now + DAY;
  // Lv5: surges paused (the pause chip on the map). Held for a month here: a real pause runs out after
  // CONFIG.pause.maxSeconds, but nobody plays this bot to pause it again.
  if (level === 5) p.pause = { state: 'paused', until: now + 30 * DAY };
  return p;
}

export function isBot(p: PlayerRecord): boolean {
  return BOT_ROLL.test(p.roll);
}

/** Create the bots that don't exist yet (each through the normal login, then set up for its level). Returns how many were made. */
export function seedBots(game: GameServer, now = Date.now()): number {
  let made = 0;
  for (let level = 1; level <= CONFIG.hq.maxLevel; level++) {
    if ([...game.players.values()].some((p) => p.roll === botRoll(level))) continue;
    const p = game.login(botName(level), botRoll(level));
    Object.assign(p, botState(level, now));
    game.commitPlayer(p);
    made++;
  }
  return made;
}

/** Delete every bot account (frees their plots). */
export function removeBots(game: GameServer): number {
  const bots = [...game.players.values()].filter(isBot);
  for (const p of bots) game.deletePlayer(p.id);
  return bots.length;
}
