import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG, PLOT, getWorld, postUpgradeCost } from '@siege/shared';
import { GameServer, type Outbox } from '../src/game.ts';
import { SqliteStore } from '../src/store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(file = ':memory:') {
  const sent: { to: string; ev: string; data: unknown }[] = [];
  const out: Outbox = {
    toPlayer: (id, ev, data) => sent.push({ to: `p:${id}`, ev, data }),
    toBase: (plot, ev, data) => sent.push({ to: `base:${plot}`, ev, data }),
    toAll: (ev, data) => sent.push({ to: 'all', ev, data }),
  };
  let t = 1_000_000;
  const store = new SqliteStore(file);
  const game = new GameServer(store, out, () => t);
  return { game, store, sent, advance: (ms: number) => (t += ms) };
}

describe('accounts & plots', () => {
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

  it('assigns plots centre-first, one per player', () => {
    const { game } = setup();
    const order = [...getWorld().plots].sort((a, b) => a.order - b.order);
    const a = game.login('Ana', 'P0001');
    const b = game.login('Ben', 'P0002');
    expect(a.plot).toBe(order[0]!.id);
    expect(b.plot).toBe(order[1]!.id);
    expect(game.ownerOf(b.plot)?.id).toBe(b.id);
    expect(game.worldSummary().map((s) => s.p).sort()).toEqual([a.plot, b.plot].sort());
  });
});

describe('actions', () => {
  it('builds and upgrades with server-side coins and gates', () => {
    const { game } = setup();
    const p = game.login('Kabir', 'K1001');
    const v = game.act(p.id, { kind: 'build', slot: 1, type: 'pistol' });
    expect(v.coins).toBe(CONFIG.start.coins - CONFIG.posts.types.pistol.build);
    expect(() => game.act(p.id, { kind: 'build', slot: 2, type: 'pistol' })).toThrow(/locked/);
    expect(() => game.act(p.id, { kind: 'hq' })).toThrow(/more coins/);
    expect(() => game.act(p.id, { hack: true })).toThrow(/Unknown action/);
    game.players.get(p.id)!.coins = 10_000;
    game.act(p.id, { kind: 'hq' });
    const up = game.act(p.id, { kind: 'post', slot: 0 });
    expect(up.base.posts[0]!.level).toBe(2);
    expect(up.coins).toBe(10_000 - CONFIG.hq.upgradeCost[0]! - postUpgradeCost('pistol', 1));
  });
});

describe('zombie waves', () => {
  it('watched bases get live waves: warning, then zombies, snapshots, kill coins', () => {
    const { game, sent } = setup();
    const p = game.login('Meera', 'M2002');
    game.connect(p.id);
    game.watch(p.plot, 1);
    const start = p.coins;
    let guard = 0;
    while (!sent.some((s) => s.ev === 'waveEnd') && guard++ < 100_000) game.tick();
    const phases = sent.filter((s) => s.ev === 'wave').map((s) => (s.data as { phase: string }).phase);
    expect(phases.slice(0, 2)).toEqual(['warning', 'wave']);
    expect(sent.filter((s) => s.ev === 'snap' && s.to === `base:${p.plot}`).length).toBeGreaterThan(20);
    const end = sent.find((s) => s.ev === 'waveEnd')!.data as { coins: number; lost: number; total: number };
    expect(end.total).toBe(start + end.coins - end.lost);
    expect(sent.some((s) => s.ev === 'coins')).toBe(true);
  });

  it("someone else watching an offline player's base: coins go to the owner's bank", () => {
    const { game, sent } = setup();
    const owner = game.login('Owner', 'O1111');
    game.watch(owner.plot, 1); // a spectator, owner offline
    let guard = 0;
    while (!sent.some((s) => s.ev === 'waveEnd') && guard++ < 100_000) game.tick();
    const rec = game.players.get(owner.id)!;
    expect(rec.bank).toBeGreaterThan(0);
    expect(rec.offline.waves).toBe(1);
    expect(sent.some((s) => s.ev === 'coins')).toBe(false);
  });

  it('unwatched offline bases resolve waves headlessly into a capped bank, credited at login', () => {
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
    const lost = rec.offline.coinsLost;
    const w = game.connect(p.id);
    expect(w.offline?.credited).toBe(CONFIG.offline.bankCap);
    expect(w.player.coins).toBe(coins - lost + CONFIG.offline.bankCap);
  });

  it('when nobody watches any more, a running wave finishes headlessly', () => {
    const { game } = setup();
    const p = game.login('Zoya', 'Z4004');
    game.watch(p.plot, 1);
    for (let i = 0; i < 4 * CONFIG.tickRate; i++) game.tick();
    expect(game.baseLive(p.plot).phase).toBe('wave');
    game.watch(p.plot, -1);
    expect(game.baseLive(p.plot).phase).toBe('calm');
  });
});

describe('raids', () => {
  function twoPlayers() {
    const s = setup();
    const a = s.game.login('Attacker', 'A9001');
    const d = s.game.login('Defender', 'D9002');
    s.game.connect(a.id);
    s.game.players.get(a.id)!.coins = 2000;
    s.game.players.get(d.id)!.coins = 1000;
    return { ...s, a, d };
  }

  it('blocks self-attacks, double raids and shielded bases', () => {
    const { game, a, d } = twoPlayers();
    expect(game.raidBlock(a.id, a.plot)).toMatch(/own base/);
    expect(game.raidBlock(a.id, 999)).toMatch(/Nobody/);
    game.attack(a.id, d.plot);
    expect(game.raidBlock(a.id, d.plot)).toMatch(/current raid/);
    const c = game.login('Third', 'T9003');
    expect(game.raidBlock(c.id, d.plot)).toMatch(/Already under attack/);
  });

  it('a won raid steals capped loot, moves trophies and shields the defender', () => {
    const { game, a, d, sent } = twoPlayers();
    game.attack(a.id, d.plot);
    expect(() => game.deploy(a.id, 'r_bat', 0, 0)).toThrow(/outside the walls/);
    expect(() => game.deploy(a.id, 'r_tank', 0, 0)).toThrow(/Unknown raider/);
    const plot = getWorld().plots[d.plot]!;
    for (let i = 0; i < 12; i++) game.deploy(a.id, 'r_bat', plot.x + 0.5, plot.y + 0.5 + (i % 4) * 0.5);
    expect(game.players.get(a.id)!.coins).toBe(2000 - 12 * CONFIG.pvp.raiders.r_bat.cost);
    let guard = 0;
    while (!sent.some((s) => s.ev === 'raidEnd') && guard++ < 10_000) game.tick();
    const res = sent.find((s) => s.ev === 'raidEnd')!.data as { won: boolean; loot: number; trophies: number };
    expect(res.won).toBe(true);
    expect(res.loot).toBe(Math.min(1000 * CONFIG.pvp.loot.pct, CONFIG.pvp.loot.capBase + CONFIG.pvp.loot.capPerHq));
    expect(game.players.get(d.id)!.coins).toBe(1000 - res.loot);
    expect(game.players.get(a.id)!.trophies).toBe(res.trophies);
    expect(game.raidBlock(a.id, d.plot)).toMatch(/Shielded/);
    expect(sent.some((s) => s.ev === 'feed')).toBe(true);
    // The spectator stream: everyone watching that plot got the fight.
    expect(sent.filter((s) => s.ev === 'snap' && s.to === `base:${d.plot}`).length).toBeGreaterThan(10);
  });

  it('a raid with nothing deployed ends as a loss', () => {
    const { game, a, d, sent } = twoPlayers();
    game.attack(a.id, d.plot);
    let guard = 0;
    while (!sent.some((s) => s.ev === 'raidEnd') && guard++ < 10_000) game.tick();
    expect((sent.find((s) => s.ev === 'raidEnd')!.data as { won: boolean }).won).toBe(false);
  });

  it('deploying needs coins, charged by the server', () => {
    const { game, a, d } = twoPlayers();
    game.players.get(a.id)!.coins = 10;
    game.attack(a.id, d.plot);
    const plot = getWorld().plots[d.plot]!;
    expect(() => game.deploy(a.id, 'r_bat', plot.x + 0.5, plot.y + PLOT - 0.5)).toThrow(/more coins/);
  });
});

describe('persistence', () => {
  it('a restarted server finds every base intact, on the same plot', () => {
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
    expect(q.plot).toBe(p.plot);
    expect(q.base.hq).toBe(2);
    expect(q.base.posts[2]).toEqual({ type: 'gun', level: 1 });
    expect(q.coins).toBe(coins);
    b.store.close();
  });
});
