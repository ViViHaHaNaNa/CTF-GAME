// A fresh, empty world: every account (bots included), the crate schedule and the admin state go.
//
//   npm run reset
//
// It backs the database up first (server/data/backups), then deletes it. Stop the game server first.
// The next start makes a new empty database (and, with DEV_MODE=true, the 8 bot accounts again).

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS } from '../src/settings.ts';
import { backupFileName } from '../src/store.ts';

const running = await fetch(`http://127.0.0.1:${SETTINGS.port}/api/health`, { signal: AbortSignal.timeout(1500) }).then(
  () => true,
  () => false,
);
if (running) {
  console.error(`The game server is running on port ${SETTINGS.port}. Stop it first (Ctrl+C in its terminal), then run this again.`);
  process.exit(1);
}

const DB = SETTINGS.db;
if (!existsSync(DB)) {
  console.log(`Nothing to reset: there is no database at ${DB} (the next start makes an empty one).`);
  process.exit(0);
}
mkdirSync(SETTINGS.backups, { recursive: true });
const backup = join(SETTINGS.backups, backupFileName());
const db = new Database(DB, { fileMustExist: true });
await db.backup(backup);
const players = (db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n;
db.close();
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
console.log(`Backed up ${players} account(s) to ${backup}`);
console.log(`Deleted ${DB}: the next start begins with an empty world${SETTINGS.devMode ? ' (and the 8 bots, DEV_MODE is on)' : ''}.`);
