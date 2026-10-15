import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BaseState, OfflineSummary } from '@siege/shared';

// Storage behind a thin interface. Today: one SQLite file. Swapping to another backend only means
// implementing Store again. Every change is written immediately (synchronous, a few µs per row).

export interface PlayerRecord {
  id: number;
  /** Normalised roll number (upper case, letters/digits): the account key. */
  roll: string;
  name: string;
  token: string;
  coins: number;
  trophies: number;
  base: BaseState;
  /** Coins earned by offline waves, credited at next login (capped). */
  bank: number;
  /** What happened while the player was away (reset at login). */
  offline: OfflineSummary;
  /** Increments every wave, so each wave gets a fresh deterministic seed. */
  waveNo: number;
  createdAt: number;
  lastSeen: number;
}

export interface Store {
  loadPlayers(): PlayerRecord[];
  /** Insert or update. Assigns `id` on first save. */
  savePlayer(p: Omit<PlayerRecord, 'id'> & { id?: number }): PlayerRecord;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY,
  roll       TEXT NOT NULL UNIQUE,
  token      TEXT NOT NULL UNIQUE,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export class SqliteStore implements Store {
  private db: Database.Database;
  private insert: Database.Statement;
  private update: Database.Statement;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.insert = this.db.prepare('INSERT INTO players (roll, token, data, updated_at) VALUES (?, ?, ?, ?)');
    this.update = this.db.prepare('UPDATE players SET roll = ?, token = ?, data = ?, updated_at = ? WHERE id = ?');
  }

  loadPlayers(): PlayerRecord[] {
    const rows = this.db.prepare('SELECT id, data FROM players ORDER BY id').all() as { id: number; data: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.data) as Omit<PlayerRecord, 'id'>), id: r.id }));
  }

  savePlayer(p: Omit<PlayerRecord, 'id'> & { id?: number }): PlayerRecord {
    const { id, ...rest } = p;
    const data = JSON.stringify(rest);
    if (id === undefined) {
      const info = this.insert.run(p.roll, p.token, data, Date.now());
      return { ...rest, id: Number(info.lastInsertRowid) };
    }
    this.update.run(p.roll, p.token, data, Date.now(), id);
    return { ...rest, id };
  }

  close() {
    this.db.close();
  }
}
