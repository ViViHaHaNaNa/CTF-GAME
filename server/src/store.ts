import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BaseState, Boosts, DirectorState, Mode, OfflineSummary, PauseState } from '@siege/shared';

// Storage behind a thin interface. Today: one SQLite file. Swapping to another backend only means
// implementing Store again. Every change is written immediately (synchronous, a few µs per row).

/** Backup file name in local time, e.g. siege-2026-10-16_14-05-09.db (sorts by date). */
export function backupFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `siege-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.db`;
}

export interface PlayerRecord {
  id: number;
  /** Normalised roll number (upper case, letters/digits): the account key. */
  roll: string;
  name: string;
  token: string;
  coins: number;
  trophies: number;
  /** World plot this base sits on (assigned at registration, never changes). */
  plot: number;
  base: BaseState;
  /** Server ms until which this base can't be raided (automatic, after a raid). */
  shieldUntil: number;
  /** Server ms until which bought immunity lasts. */
  immuneUntil: number;
  /** Active crate boosts. */
  boosts: Boosts;
  /** Coins earned by offline waves, credited at next login (capped). */
  bank: number;
  /** What happened while the player was away (reset at login). */
  offline: OfflineSummary;
  /** Increments every siege session, so each gets a fresh deterministic seed. */
  waveNo: number;
  /** Grind (pve) or Raid (pvp); kept across disconnects. Older records lack it (= the starting mode). */
  mode?: Mode;
  /** Server ms of the last mode switch. */
  modeAt?: number;
  /** The zombie director's memory of this player (difficulty pressure, minutes played). Older records lack it. */
  siege?: DirectorState;
  /** Surges paused by the player (survives reconnects and restarts). */
  pause?: PauseState;
  /** Server ms until which a new pause can't start. */
  pauseCooldownUntil?: number;
  createdAt: number;
  lastSeen: number;
}

export interface Store {
  loadPlayers(): PlayerRecord[];
  /** Insert or update. Assigns `id` on first save. */
  savePlayer(p: Omit<PlayerRecord, 'id'> & { id?: number }): PlayerRecord;
  deletePlayer(id: number): void;
  /** Write a consistent copy of the whole database (safe while the game runs). */
  backup(file: string): Promise<void>;
  /** Small named JSON blobs for game-wide state (the crate schedule). */
  getMeta<T>(key: string): T | null;
  setMeta(key: string, value: unknown): void;
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
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
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

  deletePlayer(id: number) {
    this.db.prepare('DELETE FROM players WHERE id = ?').run(id);
  }

  async backup(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    await this.db.backup(file);
  }

  getMeta<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setMeta(key: string, value: unknown) {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  close() {
    this.db.close();
  }
}
