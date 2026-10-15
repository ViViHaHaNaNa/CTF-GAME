// Copy the live database safely, even while the game is running (SQLite online backup).
//
//   npm run backup                      -> server/data/backups/siege-<date>_<time>.db (local time)
//
// To restore: stop the server, copy a backup over server/data/siege.db (delete siege.db-wal and
// siege.db-shm next to it), start the server again.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backupFileName } from '../src/store.ts';

const DB_FILE = process.env.SIEGE_DB ?? join(import.meta.dirname, '../data/siege.db');
const DIR = process.env.SIEGE_BACKUPS ?? join(import.meta.dirname, '../data/backups');

if (!existsSync(DB_FILE)) {
  console.error(`No database at ${DB_FILE}`);
  process.exit(1);
}
mkdirSync(DIR, { recursive: true });
const file = join(DIR, backupFileName());
const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
await db.backup(file);
const players = (db.prepare('SELECT COUNT(*) AS n FROM players').get() as { n: number }).n;
db.close();
console.log(`Backed up ${players} players to ${file}`);
