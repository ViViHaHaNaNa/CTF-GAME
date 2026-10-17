// The 8 development bot accounts (Bot Lv1..Bot Lv8, rolls BOT01..BOT08), one per Main Tower level.
//
//   npm run bots               delete any bot accounts and make all 8 fresh (and drop a crate)
//   npm run bots -- --remove   just delete them (do this before the event if a database ever had them)
//
// Stop the game server first: it keeps the world in memory and would overwrite these changes.
// With DEV_MODE=true the server also makes them by itself when it starts on an empty database.

import { readFileSync } from 'node:fs';
import type { Question } from '@siege/shared';
import { removeBots, seedBots } from '../src/bots.ts';
import { GameServer } from '../src/game.ts';
import { SETTINGS } from '../src/settings.ts';
import { SqliteStore } from '../src/store.ts';

const REMOVE = process.argv.includes('--remove');

const running = await fetch(`http://127.0.0.1:${SETTINGS.port}/api/health`, { signal: AbortSignal.timeout(1500) }).then(
  () => true,
  () => false,
);
if (running) {
  console.error(`The game server is running on port ${SETTINGS.port}. Stop it first (Ctrl+C in its terminal), then run this again.`);
  process.exit(1);
}

const questions = JSON.parse(readFileSync(SETTINGS.questions, 'utf8')) as Question[];
const store = new SqliteStore(SETTINGS.db);
const game = new GameServer(store, { toPlayer() {}, toBase() {}, toAll() {} }, Date.now, questions);
const removed = removeBots(game);
let made = 0;
if (!REMOVE) {
  made = seedBots(game);
  if (!game.hasOpenCrate()) game.spawnCrate('rare');
}
store.close();
console.log(REMOVE ? `Removed ${removed} bot account(s) from ${SETTINGS.db}.` : `Made ${made} bot accounts (removed ${removed} old ones) in ${SETTINGS.db}: log in as "Bot Lv1".."Bot Lv8" with roll BOT01..BOT08.`);
