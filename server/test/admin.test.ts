import Fastify from 'fastify';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG, getWorld, type Question } from '@siege/shared';
import { registerAdmin } from '../src/admin.ts';
import { GameServer, type Outbox } from '../src/game.ts';
import { SqliteStore } from '../src/store.ts';

const QUESTIONS: Question[] = [{ id: 'q', prompt: 'Q', code: '', lang: 'c', kind: 'predict-output', answers: ['42'], difficulty: 1 }];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const sent: { to: string; ev: string; data: unknown }[] = [];
  const out: Outbox = {
    toPlayer: (id, ev, data) => sent.push({ to: `p:${id}`, ev, data }),
    toBase: (plot, ev, data) => sent.push({ to: `base:${plot}`, ev, data }),
    toAll: (ev, data) => sent.push({ to: 'all', ev, data }),
  };
  let t = 1_000_000;
  const store = new SqliteStore(':memory:');
  const game = new GameServer(store, out, () => t, QUESTIONS);
  return { game, store, sent, advance: (ms: number) => (t += ms) };
}

describe('organiser controls', () => {
  it('pause stops the world and blocks actions; resume pushes timers back by the pause', () => {
    const { game, advance } = setup();
    const p = game.login('Pia', 'A1001');
    const q = game.login('Quinn', 'A1002');
    game.players.get(p.id)!.coins = 1000;
    game.buyImmunity(p.id, 5);
    const immuneBefore = game.players.get(p.id)!.immuneUntil;
    const crateBefore = game.adminState().nextCrateAt;
    game.setPaused(true);
    expect(game.status().paused).toBe(true);
    expect(() => game.act(p.id, { kind: 'walls' })).toThrow(/paused/);
    expect(() => game.attack(q.id, p.plot)).toThrow(/paused/);
    const tick = game.tickNo;
    for (let i = 0; i < 100; i++) game.tick();
    expect(game.tickNo).toBe(tick);
    advance(60_000);
    game.setPaused(false);
    expect(game.players.get(p.id)!.immuneUntil).toBe(immuneBefore + 60_000);
    expect(game.adminState().nextCrateAt).toBe(crateBefore + 60_000);
    game.tick();
    expect(game.tickNo).toBe(tick + 1);
  });

  it('a frozen leaderboard shows the standings from the moment it was frozen', () => {
    const { game } = setup();
    const p = game.login('Pia', 'A1001');
    game.players.get(p.id)!.trophies = 50;
    game.setFrozen(true);
    game.players.get(p.id)!.trophies = 80;
    expect(game.worldSummary().find((s) => s.id === p.id)!.trophies).toBe(50);
    game.setFrozen(false);
    expect(game.worldSummary().find((s) => s.id === p.id)!.trophies).toBe(80);
  });

  it('reset gives a fresh base on the same plot; delete frees the plot', () => {
    const { game } = setup();
    const p = game.login('Pia', 'A1001');
    const rec = game.players.get(p.id)!;
    rec.coins = 5000;
    rec.trophies = 70;
    rec.boosts = { loot: { pct: 1, uses: 1 } };
    game.act(p.id, { kind: 'hq' });
    const v = game.resetPlayer(p.id);
    expect(v).toMatchObject({ coins: CONFIG.start.coins, trophies: 0, plot: p.plot, boosts: {} });
    expect(v.base.hq).toBe(1);
    game.deletePlayer(p.id);
    expect(game.players.has(p.id)).toBe(false);
    expect(game.resume(p.token)).toBeNull();
    // The plot (first in order) goes to the next newcomer.
    const order = [...getWorld().plots].sort((a, b) => a.order - b.order);
    expect(game.login('New', 'A1003').plot).toBe(order[0]!.id);
  });
});

describe('admin API', () => {
  async function app(passphrase: string | undefined) {
    const s = setup();
    const dir = mkdtempSync(join(tmpdir(), 'siege-admin-'));
    dirs.push(dir);
    const kicked: number[] = [];
    const a = Fastify();
    registerAdmin(a, {
      game: s.game,
      store: s.store,
      sessions: { kick: (id) => kicked.push(id), counts: () => ({ players: 0, spectators: 0 }) },
      passphrase,
      backupDir: dir,
      stats: () => ({ tickAvgMs: 1 }),
    });
    await a.ready();
    return { ...s, a, dir, kicked };
  }

  it('is off without a passphrase', async () => {
    const { a } = await app(undefined);
    const r = await a.inject({ method: 'GET', url: '/api/admin/state', headers: { 'x-admin-pass': '' } });
    expect(r.statusCode).toBe(503);
  });

  it('rejects wrong passphrases and rate-limits guessing', async () => {
    const { a } = await app('correct horse');
    for (let i = 0; i < 5; i++) {
      const r = await a.inject({ method: 'GET', url: '/api/admin/state', headers: { 'x-admin-pass': `guess${i}` } });
      expect(r.statusCode).toBe(401);
    }
    const r = await a.inject({ method: 'GET', url: '/api/admin/state', headers: { 'x-admin-pass': 'correct horse' } });
    expect(r.statusCode).toBe(429);
  });

  it('does its jobs with the right passphrase', async () => {
    const { a, game, dir, kicked } = await app('correct horse');
    const h = { 'x-admin-pass': 'correct horse' };
    const p = game.login('Pia', 'A1001');
    const state = await a.inject({ method: 'GET', url: '/api/admin/state', headers: h });
    expect(state.json()).toMatchObject({ ok: true, paused: false, players: [{ name: 'Pia' }], server: { tickAvgMs: 1 } });
    const crate = await a.inject({ method: 'POST', url: '/api/admin/crate', headers: h, payload: { rarity: 'legendary' } });
    expect(crate.json().crate.rarity).toBe('legendary');
    expect((await a.inject({ method: 'GET', url: '/api/admin/state', headers: h })).json().crateAnswers).toEqual(['42']);
    await a.inject({ method: 'POST', url: '/api/admin/pause', headers: h, payload: { on: true } });
    expect(game.status().paused).toBe(true);
    const bad = await a.inject({ method: 'POST', url: '/api/admin/reset', headers: h, payload: { id: 999 } });
    expect(bad.statusCode).toBe(400);
    const backup = await a.inject({ method: 'POST', url: '/api/admin/backup', headers: h, payload: {} });
    expect(existsSync(backup.json().file)).toBe(true);
    expect(backup.json().file.startsWith(dir)).toBe(true);
    await a.inject({ method: 'POST', url: '/api/admin/delete', headers: h, payload: { id: p.id } });
    expect(kicked).toEqual([p.id]);
    expect(game.players.size).toBe(0);
  });
});
