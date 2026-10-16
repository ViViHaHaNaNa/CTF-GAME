import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG, PLOT, checkAnswer, decodeSnapshot, getWorld, lootable, postId, postUpgradeCost, starBonus, vaultCapacity, type CrateView, type Question } from '@siege/shared';
import { GameServer, type Outbox } from '../src/game.ts';
import { SqliteStore } from '../src/store.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const QUESTIONS: Question[] = ['a', 'b', 'c'].map((id, i) => ({
  id,
  prompt: `Question ${id}`,
  code: '',
  lang: 'python',
  kind: 'predict-output',
  answers: [`answer ${i}`],
  difficulty: 1,
}));
const answerOf = (c: CrateView) => `answer ${QUESTIONS.findIndex((q) => q.prompt === c.prompt)}`;

function setup(file = ':memory:') {
  const sent: { to: string; ev: string; data: unknown }[] = [];
  const out: Outbox = {
    toPlayer: (id, ev, data) => sent.push({ to: `p:${id}`, ev, data }),
    toBase: (plot, ev, data) => sent.push({ to: `base:${plot}`, ev, data }),
    toAll: (ev, data) => sent.push({ to: 'all', ev, data }),
  };
  let t = 1_000_000;
  const store = new SqliteStore(file);
  const game = new GameServer(store, out, () => t, QUESTIONS);
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

describe('zombie siege', () => {
  const secs = (game: GameServer, n: number) => {
    for (let i = 0; i < n * CONFIG.tickRate; i++) game.tick();
  };

  it('a player who logs in is under siege within seconds: every side, packed snapshots, batched kill coins', () => {
    const { game, sent } = setup();
    const p = game.login('Meera', 'M2002');
    game.connect(p.id);
    game.watch(p.plot, 1);
    const start = p.coins;
    secs(game, CONFIG.siege.firstSurge + 0.2);
    const surge = sent.find((s) => s.ev === 'siege')?.data as { type: string; n: number; sides: number[] };
    expect(surge).toMatchObject({ type: 'surge', n: 1 });
    for (const n of surge.sides) expect(n).toBeGreaterThan(0);
    secs(game, 20);
    const snaps = sent.filter((s) => s.ev === 'snap' && s.to === `base:${p.plot}`);
    expect(snaps.length).toBeGreaterThan(50);
    const last = decodeSnapshot(snaps.at(-1)!.data as Uint8Array);
    expect(last.p).toBe(p.plot);
    expect(sent.some((s) => s.ev === 'siege' && (s.data as { type: string }).type === 'held')).toBe(true);
    game.flushCoins();
    const coins = sent.filter((s) => s.ev === 'coins');
    expect(coins.length).toBeGreaterThan(0);
    // Batched: far fewer messages than kills, and they add up.
    const total = coins.reduce((a, s) => a + (s.data as { delta: number }).delta, 0);
    expect(game.players.get(p.id)!.coins).toBe(start + total);
    expect(sent.some((s) => s.ev === 'pressure' && s.to === `p:${p.id}`)).toBe(true);
  });

  it('upgrades join the running siege at once', () => {
    const { game } = setup();
    const p = game.login('Ishan', 'I5005');
    game.connect(p.id);
    game.watch(p.plot, 1);
    secs(game, 3);
    game.act(p.id, { kind: 'build', slot: 1, type: 'pistol' });
    const snap = decodeSnapshot(game.baseLive(p.plot).snapshot!);
    expect(snap.b.some(([id]) => id === postId(1))).toBe(true);
  });

  it("someone else watching an offline player's base: coins go to the owner's bank", () => {
    const { game, sent } = setup();
    const owner = game.login('Owner', 'O1111');
    game.watch(owner.plot, 1); // a spectator, owner offline
    secs(game, 30);
    const rec = game.players.get(owner.id)!;
    expect(rec.bank).toBeGreaterThan(0);
    expect(rec.offline.waves).toBeGreaterThan(0);
    expect(sent.some((s) => s.ev === 'coins')).toBe(false);
  });

  it('unwatched offline bases resolve sieges headlessly into a capped bank, credited at login', () => {
    const { game, advance } = setup();
    const p = game.login('Dev', 'D3003');
    const coins = p.coins;
    for (let i = 0; i < 60; i++) {
      advance(CONFIG.offline.every * 1000 + 1);
      game.tickOffline(10);
    }
    const rec = game.players.get(p.id)!;
    expect(rec.offline.waves).toBeGreaterThan(60);
    // The bank stops at its cap or when the vault would be full, whichever comes first.
    const credited = rec.bank;
    expect(credited).toBe(Math.min(CONFIG.offline.bankCap, vaultCapacity(1) - coins + rec.offline.coinsLost));
    const lost = rec.offline.coinsLost;
    expect(lost).toBeLessThanOrEqual(rec.offline.breaches * CONFIG.siege.breach.maxLoss);
    const w = game.connect(p.id);
    expect(w.offline?.credited).toBe(credited);
    expect(w.player.coins).toBe(coins - lost + credited);
  });

  it('when nobody watches any more, the base goes back to headless sieges', () => {
    const { game } = setup();
    const p = game.login('Zoya', 'Z4004');
    game.watch(p.plot, 1);
    secs(game, 4);
    expect(game.baseLive(p.plot).phase).toBe('wave');
    game.watch(p.plot, -1);
    expect(game.baseLive(p.plot).phase).toBe('calm');
  });

  it('a breach costs a small capped amount and the siege goes on', () => {
    const { game, sent } = setup();
    const p = game.login('Tara', 'T6006');
    const rec = game.players.get(p.id)!;
    rec.coins = 5000;
    rec.base = { hq: 4, walls: 1, posts: rec.base.posts.map(() => null) };
    game.connect(p.id);
    game.watch(p.plot, 1);
    let guard = 0;
    while (!sent.some((s) => s.ev === 'siege' && (s.data as { type: string }).type === 'breach') && guard++ < 200 * CONFIG.tickRate) game.tick();
    const b = sent.find((s) => s.ev === 'siege' && (s.data as { type: string }).type === 'breach')!.data as { lost: number; total: number };
    expect(b.lost).toBe(CONFIG.siege.breach.maxLoss);
    expect(b.total).toBe(game.players.get(p.id)!.coins);
    secs(game, CONFIG.siege.breach.breather + 2);
    expect(game.baseLive(p.plot).phase).toBe('wave');
  });
});

describe('commander taps', () => {
  it('taps on your own siege are resolved by the server and shown to everyone watching; others cannot tap it', () => {
    const { game, sent } = setup();
    const p = game.login('Arjun', 'R7007');
    const q = game.login('Other', 'R7008');
    game.connect(p.id);
    game.connect(q.id);
    game.watch(p.plot, 1);
    for (let i = 0; i < (CONFIG.siege.firstSurge + 1.5) * CONFIG.tickRate; i++) game.tick();
    const plot = getWorld().plots[p.plot]!;
    const snap = decodeSnapshot(game.baseLive(p.plot).snapshot!);
    const z = snap.u.find((u) => u[5] !== 3 && u[5] !== 2)!;
    game.tap(p.id, z[2] / 16, z[3] / 16);
    const hit = sent.find((s) => s.ev === 'tap' && s.to === `base:${p.plot}`)?.data as { ok: boolean; hits: unknown[]; mag: number };
    expect(hit).toMatchObject({ ok: true, mag: CONFIG.commander.weapons.pistol.magazine - 1 });
    expect(hit.hits.length).toBe(1);
    // Too fast: refused, and only the shooter hears about it.
    game.tap(p.id, z[2] / 16, z[3] / 16);
    expect(sent.find((s) => s.ev === 'tap' && s.to === `p:${p.id}`)?.data).toMatchObject({ ok: false, error: 'too fast' });
    // Someone else can't shoot at it, and you can't shoot far from your base.
    const hitsBefore = sent.filter((s) => s.ev === 'tap' && s.to === `base:${p.plot}`).length;
    game.tap(q.id, z[2] / 16, z[3] / 16);
    game.tap(p.id, plot.x + 40, plot.y);
    expect(sent.filter((s) => s.ev === 'tap' && s.to === `base:${p.plot}`).length).toBe(hitsBefore);
    expect(sent.find((s) => s.ev === 'tap' && s.to === `p:${q.id}`)?.data).toMatchObject({ ok: false, error: 'no siege' });
    expect(sent.filter((s) => s.ev === 'tap' && s.to === `p:${p.id}`).at(-1)?.data).toMatchObject({ ok: false, error: 'out of reach' });
    // Airstrike: once, then its cooldown.
    expect(game.airstrike(p.id, plot.x + 7, plot.y + 1)).toMatchObject({ ok: true });
    expect(() => game.airstrike(p.id, plot.x + 7, plot.y + 1)).toThrow(/ready in/);
    expect(sent.some((s) => s.ev === 'airstrike' && s.to === `base:${p.plot}`)).toBe(true);
  });

  it('the Commander weapon is bought with coins once the Main Tower allows it', () => {
    const { game } = setup();
    const p = game.login('Neha', 'R7009');
    expect(() => game.act(p.id, { kind: 'commander' })).toThrow(/Main Tower level 2/);
    game.players.get(p.id)!.coins = 5000;
    game.act(p.id, { kind: 'hq' });
    expect(game.act(p.id, { kind: 'commander' }).base.cmd).toBe(1);
    expect(game.worldSummary().find((b) => b.id === p.id)!.cmd).toBe(1);
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
    s.game.setMode(a.id, 'pvp');
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
    const res = sent.find((s) => s.ev === 'raidEnd')!.data as { won: boolean; stars: number; reason: string; vault: boolean; loot: number; trophies: number };
    expect(res).toMatchObject({ won: true, stars: 3, reason: 'cleared', vault: true });
    // Everything down, vault included: the whole stake from the defender, plus 3 stars of bonus (even match).
    const stolen = lootable(1000, 1);
    expect(res.loot).toBe(stolen + starBonus(3, 1));
    expect(game.players.get(d.id)!.coins).toBe(1000 - stolen);
    expect(game.players.get(a.id)!.trophies).toBe(res.trophies);
    expect(game.raidBlock(a.id, d.plot)).toMatch(/Shielded/);
    expect(sent.some((s) => s.ev === 'feed')).toBe(true);
    // The spectator stream: everyone watching that plot got the fight.
    expect(sent.filter((s) => s.ev === 'snap' && s.to === `base:${d.plot}`).length).toBeGreaterThan(10);
  });

  it('climbing to the top of the leaderboard makes the feed', () => {
    const { game, a, d, sent } = twoPlayers();
    expect(game.rankOf(a.id)).toBe(1); // tie on 0 trophies: the earlier player ranks first
    game.players.get(d.id)!.trophies = 20;
    expect(game.rankOf(a.id)).toBe(2);
    game.attack(a.id, d.plot);
    const plot = getWorld().plots[d.plot]!;
    for (let i = 0; i < 12; i++) game.deploy(a.id, 'r_bat', plot.x + 0.5, plot.y + 0.5 + (i % 4) * 0.5);
    let guard = 0;
    while (!sent.some((s) => s.ev === 'raidEnd') && guard++ < 10_000) game.tick();
    expect((sent.find((s) => s.ev === 'raidEnd')!.data as { won: boolean }).won).toBe(true);
    expect(game.rankOf(a.id)).toBe(1);
    expect(sent.some((s) => s.ev === 'feed' && (s.data as { text: string }).text === 'Attacker is now #1!')).toBe(true);
  });

  it('nothing deployed within 30 s: cancelled, no cost to either player', () => {
    const { game, a, d, sent, advance } = twoPlayers();
    const rec = game.players.get(a.id)!;
    rec.immuneUntil = 1_000_000 + 10 * 60_000;
    rec.boosts = { attack: { pct: 0.25, uses: 3 } };
    game.attack(a.id, d.plot);
    expect(game.players.get(a.id)!.immuneUntil).toBe(0);
    let guard = 0;
    while (!sent.some((s) => s.ev === 'raidEnd') && guard++ < 10_000) game.tick();
    const res = sent.find((s) => s.ev === 'raidEnd')!.data as { reason: string; loot: number; trophies: number };
    expect(res).toMatchObject({ reason: 'cancelled', loot: 0, trophies: 0 });
    expect(guard).toBe(CONFIG.pvp.stall.noDeploy * CONFIG.tickRate);
    const after = game.players.get(a.id)!;
    expect(after.coins).toBe(2000);
    expect(after.immuneUntil).toBe(1_000_000 + 10 * 60_000);
    expect(after.boosts.attack?.uses).toBe(3);
    expect(game.players.get(d.id)!.coins).toBe(1000);
    // No shield for the defender: nothing happened to them.
    advance(1);
    const third = game.login('Third', 'T9004');
    game.setMode(third.id, 'pvp');
    expect(game.raidBlock(third.id, d.plot)).toBeNull();
  });

  it('End attack scores whatever is destroyed so far', () => {
    const { game, a, d, sent } = twoPlayers();
    game.attack(a.id, d.plot);
    const plot = getWorld().plots[d.plot]!;
    for (let i = 0; i < 3; i++) game.deploy(a.id, 'r_bat', plot.x + 0.5, plot.y + 0.5 + i * 0.5);
    for (let i = 0; i < 3 * CONFIG.tickRate; i++) game.tick();
    game.retreat(a.id);
    game.tick();
    const res = sent.find((s) => s.ev === 'raidEnd')!.data as { reason: string; stars: number; won: boolean };
    expect(res.reason).toBe('ended');
    expect(res.won).toBe(res.stars > 0);
  });

  it('every raider dead and no coins for another: the raid ends', () => {
    const { game, a, d, sent } = twoPlayers();
    game.attack(a.id, d.plot);
    const plot = getWorld().plots[d.plot]!;
    game.players.get(a.id)!.coins = CONFIG.pvp.raiders.r_bat.cost;
    game.deploy(a.id, 'r_bat', plot.x + 0.5, plot.y + 0.5);
    let guard = 0;
    while (!sent.some((s) => s.ev === 'raidEnd') && guard++ < 10_000) game.tick();
    expect((sent.find((s) => s.ev === 'raidEnd')!.data as { reason: string }).reason).toBe('army');
    // The live status never had a timer in it.
    const status = sent.filter((s) => s.ev === 'raid').at(-1)!.data as Record<string, unknown>;
    expect(status).not.toHaveProperty('left');
    expect(status).toMatchObject({ armyLeft: 0 });
  });

  it('deploying needs coins, charged by the server', () => {
    const { game, a, d } = twoPlayers();
    game.players.get(a.id)!.coins = 10;
    game.attack(a.id, d.plot);
    const plot = getWorld().plots[d.plot]!;
    expect(() => game.deploy(a.id, 'r_bat', plot.x + 0.5, plot.y + PLOT - 0.5)).toThrow(/more coins/);
  });
});

describe('immunity', () => {
  it('blocks raids, costs coins, and ends when the immune player attacks', () => {
    const { game } = setup();
    const a = game.login('Asha', 'I1001');
    const d = game.login('Dhruv', 'I1002');
    game.players.get(a.id)!.coins = 1000;
    game.players.get(d.id)!.coins = 1000;
    const v = game.buyImmunity(d.id, 5);
    expect(v.coins).toBe(1000 - CONFIG.immunity.options[0]!.cost);
    expect(game.raidBlock(a.id, d.plot)).toMatch(/Immune/);
    expect(() => game.buyImmunity(d.id, 7)).toThrow(/5 or 10/);
    game.buyImmunity(d.id, 10); // 15 minutes in total: allowed
    expect(() => game.buyImmunity(d.id, 5)).toThrow(/15 minutes/);
    // The immune player attacks someone: their immunity ends.
    game.setMode(d.id, 'pvp');
    game.attack(d.id, a.plot);
    expect(game.players.get(d.id)!.immuneUntil).toBe(0);
  });
});

describe('crates', () => {
  it('two players race: exactly one wins, the other is told who did', () => {
    const { game, sent } = setup();
    const p1 = game.login('First', 'C1001');
    const p2 = game.login('Second', 'C1002');
    const crate = game.spawnCrate('epic')!;
    expect(crate).not.toHaveProperty('answer');
    expect(sent.some((s) => s.ev === 'crate' && s.to === 'all')).toBe(true);
    const r1 = game.answer(p1.id, crate.id, `  ${answerOf(crate).toUpperCase()}; `);
    expect(r1.correct).toBe(true);
    expect(() => game.answer(p2.id, crate.id, answerOf(crate))).toThrow(/First already claimed/);
    const view = game.crateView()!;
    expect(view.claimedBy).toBe('First');
    expect(view.answer).toBe(answerOf(crate));
    expect(Object.keys(game.players.get(p1.id)!.boosts)).toHaveLength(1);
    expect(game.players.get(p2.id)!.boosts).toEqual({});
    expect(sent.some((s) => s.ev === 'feed' && (s.data as { text: string }).text.includes('First cracked'))).toBe(true);
  });

  it('rate-limits wrong answers, with a longer lock every few misses', () => {
    const { game, advance } = setup();
    const p = game.login('Guesser', 'C2001');
    const crate = game.spawnCrate()!;
    expect(game.answer(p.id, crate.id, 'nope')).toEqual({ correct: false, retryIn: CONFIG.crates.wrongCooldown });
    expect(() => game.answer(p.id, crate.id, answerOf(crate))).toThrow(/Wait/);
    for (let i = 1; i < CONFIG.crates.lockAfter; i++) {
      advance(CONFIG.crates.wrongCooldown * 1000);
      const r = game.answer(p.id, crate.id, 'nope');
      if (i === CONFIG.crates.lockAfter - 1) expect(r.retryIn).toBe(CONFIG.crates.lockFor);
    }
    advance(CONFIG.crates.wrongCooldown * 1000);
    expect(() => game.answer(p.id, crate.id, answerOf(crate))).toThrow(/Wait/);
    advance(CONFIG.crates.lockFor * 1000);
    expect(game.answer(p.id, crate.id, answerOf(crate)).correct).toBe(true);
  });

  it('no repeated questions until the bank is used up; unclaimed crates expire when the next drops', () => {
    const { game, sent, advance } = setup();
    const p = game.login('Late', 'C3001');
    const seen = new Set<string>();
    let first: CrateView | null = null;
    for (let i = 0; i < QUESTIONS.length; i++) {
      advance(CONFIG.crates.every * 1000);
      for (let k = 0; k < CONFIG.tickRate; k++) game.tick();
      const c = game.crateView()!;
      first ??= c;
      seen.add(c.prompt);
    }
    expect(seen.size).toBe(QUESTIONS.length);
    expect(() => game.answer(p.id, first!.id, answerOf(first!))).toThrow(/gone/);
    expect(sent.some((s) => s.ev === 'feed' && (s.data as { text: string }).text.includes('Nobody cracked'))).toBe(true);
  });

  it('the crate schedule survives a restart (same crate, no repeat next)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'siege-'));
    dirs.push(dir);
    const file = join(dir, 'siege.db');
    const a = setup(file);
    const c1 = a.game.spawnCrate()!;
    a.store.close();
    const b = setup(file);
    expect(b.game.crateView()?.id).toBe(c1.id);
    expect(b.game.spawnCrate()!.prompt).not.toBe(c1.prompt);
    b.store.close();
  });
});

describe('boosts', () => {
  it('attack and loot boosts are used up by a raid and change its result', () => {
    const { game, sent } = setup();
    const a = game.login('Booster', 'B1001');
    const d = game.login('Target', 'B1002');
    game.connect(a.id);
    game.players.get(a.id)!.coins = 2000;
    game.players.get(d.id)!.coins = 1000;
    game.players.get(a.id)!.boosts = { attack: { pct: 0.6, uses: 3 }, loot: { pct: 1, uses: 1 } };
    game.setMode(a.id, 'pvp');
    game.attack(a.id, d.plot);
    expect(game.players.get(a.id)!.boosts).toEqual({ attack: { pct: 0.6, uses: 2 } });
    const plot = getWorld().plots[d.plot]!;
    for (let i = 0; i < 12; i++) game.deploy(a.id, 'r_bat', plot.x + 0.5, plot.y + 0.5 + (i % 4) * 0.5);
    let guard = 0;
    while (!sent.some((s) => s.ev === 'raidEnd') && guard++ < 10_000) game.tick();
    const res = sent.find((s) => s.ev === 'raidEnd')!.data as { won: boolean; loot: number };
    expect(res.won).toBe(true);
    // A +100% loot boost doubles both what's stolen and the star bonus.
    expect(res.loot).toBe(2 * lootable(1000, 1) + 2 * starBonus(3, 1));
  });
});

describe('modes', () => {
  it('Grind runs the swarms and blocks raiding; Raid pauses them and allows it; the switch has a cooldown', () => {
    const { game, sent, advance } = setup();
    const p = game.login('Mode', 'M8001');
    const q = game.login('Other', 'M8002');
    game.connect(p.id);
    game.watch(p.plot, 1);
    expect(game.players.get(p.id)!.mode).toBe('pve');
    expect(game.raidBlock(p.id, q.plot)).toMatch(/Raid mode/);
    for (let i = 0; i < CONFIG.siege.firstSurge * CONFIG.tickRate + 5; i++) game.tick();
    // Locked during a surge.
    expect(() => game.setMode(p.id, 'pvp')).toThrow(/surge/);
    let guard = 0;
    while (game.modeBlock(p.id) && guard++ < 60 * CONFIG.tickRate) game.tick();
    expect(game.setMode(p.id, 'pvp').mode).toBe('pvp');
    expect(game.baseLive(p.plot).phase).toBe('calm');
    expect(game.worldSummary().find((b) => b.id === p.id)!.mode).toBe('pvp');
    expect(game.raidBlock(p.id, q.plot)).toBeNull();
    // No zombies while raiding: no snapshots with units, no coins.
    const coins = game.players.get(p.id)!.coins;
    for (let i = 0; i < 10 * CONFIG.tickRate; i++) game.tick();
    expect(game.players.get(p.id)!.coins).toBe(coins);
    // Cooldown before switching back.
    expect(() => game.setMode(p.id, 'pve')).toThrow(/switch again in/);
    advance(CONFIG.modes.cooldown * 1000);
    expect(game.setMode(p.id, 'pve').mode).toBe('pve');
    for (let i = 0; i < (CONFIG.siege.firstSurge + 1) * CONFIG.tickRate; i++) game.tick();
    expect(game.baseLive(p.plot).phase).toBe('wave');
    expect(sent.some((s) => s.ev === 'feed' && /out raiding/.test((s.data as { text: string }).text))).toBe(true);
  });

  it('any base can be raided whatever its mode; raiding locks the switch for both sides; the mode survives a restart of the session', () => {
    const { game, a, d } = (() => {
      const s = setup();
      const a = s.game.login('Raider', 'M8003');
      const d = s.game.login('Grinder', 'M8004');
      s.game.connect(a.id);
      s.game.players.get(a.id)!.coins = 2000;
      return { ...s, a, d };
    })();
    game.setMode(a.id, 'pvp');
    expect(game.players.get(d.id)!.mode).toBe('pve');
    game.attack(a.id, d.plot);
    expect(game.modeBlock(a.id)).toMatch(/raid/);
    expect(game.modeBlock(d.id)).toMatch(/being raided/);
    game.disconnect(a.id);
    expect(game.players.get(a.id)!.mode).toBe('pvp');
    // Once the raid is over, the attacker can switch back at once (no cooldown).
    game.retreat(a.id);
    game.tick();
    expect(game.modeBlock(a.id)).toBeNull();
    expect(game.setMode(a.id, 'pve').mode).toBe('pve');
  });

  it("zombie coins stop when the vault is full (other coins don't)", () => {
    const { game } = setup();
    const p = game.login('Full', 'M8005');
    game.connect(p.id);
    game.watch(p.plot, 1);
    const cap = vaultCapacity(1);
    game.players.get(p.id)!.coins = cap - 3;
    for (let i = 0; i < 40 * CONFIG.tickRate; i++) game.tick();
    game.flushCoins();
    expect(game.players.get(p.id)!.coins).toBe(cap);
    expect(game.worldSummary().find((b) => b.id === p.id)!.vaultFull).toBe(true);
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

describe('question bank', () => {
  it('every question has a unique id and accepts its own answers', () => {
    const bank = JSON.parse(readFileSync(join(import.meta.dirname, '../data/questions.json'), 'utf8')) as Question[];
    expect(new Set(bank.map((q) => q.id)).size).toBe(bank.length);
    for (const q of bank) {
      expect(q.prompt.length).toBeGreaterThan(0);
      for (const a of q.answers) expect(checkAnswer(q, a), q.id).toBe(true);
    }
  });
});
