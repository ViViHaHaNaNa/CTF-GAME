import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG, postUpgradeCost } from '@siege/shared';
import { GameServer, type Outbox } from '../src/game.ts';
import { SqliteStore } from '../src/store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(file = ':memory:') {
  const sent: { id: number; ev: string; data: unknown }[] = [];
  const out: Outbox = { toPlayer: (id, ev, data) => sent.push({ id, ev, data }) };
  let t = 1_000_000;
  const store = new SqliteStore(file);
  const game = new GameServer(store, out, () => t);
  return { game, store, sent, advance: (ms: number) => (t += ms) };
}

describe('accounts', () => {
  it('one account per roll number; the name must match on return', () => {
    const { game } = setup();
    const a = game.login('Riya', 'a-0123 ');
    expect(a.roll).toBe('A0123');
    expect(game.login('riya', 'A0123').id).toBe(a.id);
    expect(() => game.login('Someone Else', 'A0123')).toThrow(/different name/);
    expect(() => game.login('Riya', '12')).toThrow(/roll number/);
    expect(() => game.login('R', 'B0123')).toThrow(/Name/);
    expect(game.resume(a.token)?.id).toBe(a.id);
    expect(game.resume('nope')).toBeNull();
  });
});

describe('actions', () => {
  it('builds and upgrades with server-side coins and gates', () => {
    const { game } = setup();
    const p = game.login('Kabir', 'K1001');
    const v = game.act(p.id, { kind: 'build', slot: 1, type: 'pistol' });
    expect(v.coins).toBe(CONFIG.start.coins - CONFIG.posts.types.pistol.build);
    expect(v.base.posts[1]).toEqual({ type: 'pistol', level: 1 });
    expect(() => game.act(p.id, { kind: 'build', slot: 2, type: 'pistol' })).toThrow(/locked/);
    expect(() => game.act(p.id, { kind: 'post', slot: 0 })).toThrow(/Main Tower level 2/);
    expect(() => game.act(p.id, { kind: 'hq' })).toThrow(/more coins/);
    expect(() => game.act(p.id, { kind: 'build', slot: 1, type: 'pistol', coins: 999999 })).toThrow(/already/);
    expect(() => game.act(p.id, { hack: true })).toThrow(/Unknown action/);
    // Plenty of coins: HQ 2 unlocks the post upgrade.
    game.players.get(p.id)!.coins = 10_000;
    game.act(p.id, { kind: 'hq' });
    const up = game.act(p.id, { kind: 'post', slot: 0 });
    expect(up.base.posts[0]!.level).toBe(2);
    expect(up.coins).toBe(10_000 - CONFIG.hq.upgradeCost[0]! - postUpgradeCost('pistol', 1));
  });
});

describe('waves', () => {
  it('online players get a live wave: snapshots stream, kill coins are credited as they happen', () => {
    const { game, sent } = setup();
    const p = game.login('Meera', 'M2002');
    game.connect(p.id);
    const start = p.coins;
    let guard = 0;
    while (!sent.some((s) => s.ev === 'waveEnd') && guard++ < 100_000) game.tick();
    const snaps = sent.filter((s) => s.ev === 'snap');
    expect(snaps.length).toBeGreaterThan(20);
    const end = sent.find((s) => s.ev === 'waveEnd')!.data as { coins: number; lost: number; total: number };
    expect(end.total).toBe(start + end.coins - end.lost);
    expect(game.players.get(p.id)!.coins).toBe(end.total);
    expect(sent.some((s) => s.ev === 'coins')).toBe(true);
    // ...and then a calm period before the next wave.
    const last = sent.filter((s) => s.ev === 'wave').at(-1)!.data as { phase: string };
    expect(last.phase).toBe('calm');
  });

  it('offline bases resolve waves headlessly into a capped bank, credited at login', () => {
    const { game, advance } = setup();
    const p = game.login('Dev', 'D3003');
    const coins = p.coins;
    for (let i = 0; i < 200; i++) {
      advance(CONFIG.offline.waveEvery * 1000 + 1);
      game.tickOffline(10);
    }
    const rec = game.players.get(p.id)!;
    expect(rec.offline.waves).toBe(200);
    expect(rec.bank).toBe(CONFIG.offline.bankCap);
    expect(rec.offline.capped).toBe(true);
    const lost = rec.offline.coinsLost;
    const w = game.connect(p.id);
    expect(w.offline?.credited).toBe(CONFIG.offline.bankCap);
    expect(w.offline?.coinsLost).toBe(lost);
    expect(w.player.coins).toBe(coins - lost + CONFIG.offline.bankCap);
    expect(game.players.get(p.id)!.bank).toBe(0);
  });

  it('a disconnect mid-wave finishes that wave headlessly', () => {
    const { game } = setup();
    const p = game.login('Zoya', 'Z4004');
    game.connect(p.id);
    for (let i = 0; i < 4 * CONFIG.tickRate; i++) game.tick(); // into the wave
    expect(game.waveInfo(p.id).phase).toBe('wave');
    game.disconnect(p.id);
    expect(game.isOnline(p.id)).toBe(false);
    expect(game.waveInfo(p.id).phase).toBe('calm');
  });
});

describe('persistence', () => {
  it('a restarted server finds every base intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'siege-'));
    dirs.push(dir);
    const file = join(dir, 'siege.db');
    const a = setup(file);
    const p = a.game.login('Arjun', 'R5005');
    a.game.players.get(p.id)!.coins = 5000;
    a.game.act(p.id, { kind: 'hq' });
    a.game.act(p.id, { kind: 'build', slot: 2, type: 'gun' });
    const coins = a.game.players.get(p.id)!.coins;
    a.store.close();

    const b = setup(file);
    const q = b.game.resume(p.token)!;
    expect(q.base.hq).toBe(2);
    expect(q.base.posts[2]).toEqual({ type: 'gun', level: 1 });
    expect(q.coins).toBe(coins);
    expect(b.game.login('Arjun', 'R5005').id).toBe(p.id);
    b.store.close();
  });
});
