import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RARITIES, type Rarity } from '@siege/shared';
import { GameError, type GameServer } from './game.ts';
import type { Sessions } from './net.ts';
import { backupFileName, type Store } from './store.ts';

// Organiser API for /siege/admin. Every call carries the passphrase (from SIEGE_ADMIN_PASS) in the
// x-admin-pass header. Wrong guesses are rate-limited per address. With no passphrase set, admin is off.

export interface AdminDeps {
  game: GameServer;
  sessions: Sessions;
  store: Store;
  passphrase: string | undefined;
  backupDir: string;
  /** Server health numbers shown on the admin page. */
  stats: () => Record<string, unknown>;
}

const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 60_000;

const digest = (s: string) => createHash('sha256').update(s).digest();

export function registerAdmin(app: FastifyInstance, d: AdminDeps) {
  const fails = new Map<string, number[]>();
  const want = d.passphrase ? digest(d.passphrase) : null;

  /** Checks the passphrase; replies and returns false when the request must stop. */
  const allowed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!want) {
      void reply.code(503).send({ ok: false, error: 'Admin is off: start the server with SIEGE_ADMIN_PASS set' });
      return false;
    }
    const ip = req.ip;
    const now = Date.now();
    const recent = (fails.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (recent.length >= MAX_FAILS) {
      void reply.code(429).send({ ok: false, error: 'Too many wrong passphrases. Wait a minute.' });
      return false;
    }
    const given = req.headers['x-admin-pass'];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), want)) {
      recent.push(now);
      fails.set(ip, recent);
      void reply.code(401).send({ ok: false, error: 'Wrong passphrase' });
      return false;
    }
    fails.delete(ip);
    return true;
  };

  /** Run an admin action, turning game errors into a 400 with their message. */
  const route = (path: string, fn: (body: Record<string, unknown>) => unknown | Promise<unknown>) => {
    app.post(`/api/admin/${path}`, async (req, reply) => {
      if (!allowed(req, reply)) return reply;
      try {
        const result = await fn((req.body ?? {}) as Record<string, unknown>);
        return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
      } catch (e) {
        if (e instanceof GameError) return reply.code(400).send({ ok: false, error: e.message });
        throw e;
      }
    });
  };

  app.get('/api/admin/state', async (req, reply) => {
    if (!allowed(req, reply)) return reply;
    return { ok: true, ...d.game.adminState(), server: { ...d.stats(), ...d.sessions.counts() } };
  });

  route('crate', (b) => {
    const rarity = RARITIES.includes(b.rarity as Rarity) ? (b.rarity as Rarity) : undefined;
    const crate = d.game.spawnCrate(rarity);
    if (!crate) throw new GameError('no_questions', 'The question bank is empty');
    return { crate };
  });
  route('pause', (b) => d.game.setPaused(b.on === true));
  route('freeze', (b) => d.game.setFrozen(b.on === true));
  route('reset', (b) => ({ player: d.game.resetPlayer(Number(b.id)) }));
  route('delete', (b) => {
    const id = Number(b.id);
    if (!d.game.players.has(id)) throw new GameError('no_player', 'No such player');
    d.sessions.kick(id);
    d.game.deletePlayer(id);
  });
  route('backup', async () => {
    const file = join(d.backupDir, backupFileName());
    await d.store.backup(file);
    return { file };
  });
}
