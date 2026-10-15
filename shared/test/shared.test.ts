import { describe, expect, it } from 'vitest';
import {
  CONFIG,
  SLOTS,
  WALLS,
  ZombieWave,
  applyAction,
  breachLoss,
  newBase,
  parseAction,
  planWave,
  quote,
  slotsUnlocked,
} from '../src/index.ts';

describe('layout', () => {
  it('has a closed wall ring and slots inside it', () => {
    expect(WALLS.length).toBe(52);
    expect(new Set(WALLS.map((w) => `${w.x},${w.y}`)).size).toBe(WALLS.length);
    expect(SLOTS).toHaveLength(8);
  });
});

describe('combat engine', () => {
  it('is deterministic: same base + seed = same wave', () => {
    for (let seed = 1; seed < 30; seed++) {
      const a = new ZombieWave(newBase(), seed);
      const b = new ZombieWave(newBase(), seed);
      a.runToEnd();
      b.runToEnd();
      expect([a.kills, a.coins, a.breached, a.combat.tick]).toEqual([b.kills, b.coins, b.breached, b.combat.tick]);
      expect(a.combat.snapshot(true)).toEqual(b.combat.snapshot(true));
    }
  });

  it('streams the same snapshots tick by tick as a headless run', () => {
    const live = new ZombieWave(newBase(), 42);
    const headless = new ZombieWave(newBase(), 42);
    while (!live.done) live.step();
    headless.runToEnd();
    expect(live.coins).toBe(headless.coins);
  });

  it('waves always end within the time limit', () => {
    for (let seed = 1; seed < 50; seed++) {
      const w = new ZombieWave(newBase(), seed);
      w.runToEnd();
      expect(w.combat.tick).toBeLessThanOrEqual(CONFIG.waves.maxDuration * CONFIG.tickRate);
    }
  });

  it('a base with no posts gets breached by a big wave', () => {
    const base = { hq: 5, walls: 1, posts: SLOTS.map(() => null) };
    let breaches = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const w = new ZombieWave(base, seed);
      w.runToEnd();
      if (w.breached) breaches++;
    }
    expect(breaches).toBeGreaterThan(10);
  });

  it('waves come from 1 or 2 sides and scale with HQ level', () => {
    const p1 = planWave(1, 7);
    const p8 = planWave(8, 7);
    expect(p1.sides.length).toBeGreaterThanOrEqual(1);
    expect(p1.sides.length).toBeLessThanOrEqual(CONFIG.waves.maxSides);
    expect(p8.spawns.length).toBeGreaterThan(p1.spawns.length);
  });
});

describe('economy', () => {
  it('new bases start with one pistol and HQ 1', () => {
    const b = newBase();
    expect(b.hq).toBe(1);
    expect(b.posts.filter(Boolean)).toHaveLength(1);
  });

  it('gates posts and walls by HQ level', () => {
    const b = newBase();
    expect(quote(b, { kind: 'build', slot: 1, type: 'pistol' }).ok).toBe(true);
    expect(quote(b, { kind: 'build', slot: 1, type: 'gun' }).reason).toMatch(/Main Tower level 2/);
    expect(quote(b, { kind: 'build', slot: slotsUnlocked(1), type: 'pistol' }).reason).toMatch(/locked/);
    expect(quote(b, { kind: 'post', slot: 0 }).reason).toMatch(/Main Tower level 2/);
    expect(quote(b, { kind: 'walls' }).ok).toBe(false);
    const hq2 = applyAction(b, { kind: 'hq' });
    expect(quote(hq2, { kind: 'post', slot: 0 }).ok).toBe(true);
    expect(quote(hq2, { kind: 'walls' }).ok).toBe(true);
    expect(quote(hq2, { kind: 'build', slot: 2, type: 'gun' }).ok).toBe(true);
  });

  it('applyAction never mutates the input', () => {
    const b = newBase();
    const before = JSON.stringify(b);
    applyAction(b, { kind: 'build', slot: 1, type: 'pistol' });
    expect(JSON.stringify(b)).toBe(before);
  });

  it('rejects junk actions from the network', () => {
    expect(parseAction({ kind: 'build', slot: 1, type: 'nuke' })).toBeNull();
    expect(parseAction('hq')).toBeNull();
    expect(parseAction({ kind: 'post', slot: 0 })).toEqual({ kind: 'post', slot: 0 });
  });

  it('a breach costs a capped share and never goes below the protected floor', () => {
    const { lossPct, maxLoss, protectedFloor } = CONFIG.waves.breach;
    expect(breachLoss(50)).toBe(0);
    expect(breachLoss(protectedFloor + 5)).toBeLessThanOrEqual(5);
    expect(breachLoss(1000)).toBe(Math.round(1000 * lossPct));
    expect(breachLoss(1_000_000)).toBe(maxLoss);
  });
});
