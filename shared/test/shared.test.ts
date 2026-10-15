import { describe, expect, it } from 'vitest';
import {
  CONFIG,
  PLOT,
  SLOTS,
  WALLS,
  Raid,
  ZombieWave,
  applyAction,
  baseBuildings,
  breachLoss,
  checkAnswer,
  generateWorld,
  grantCrate,
  rollRarity,
  getWorld,
  inDeployZone,
  lootable,
  newBase,
  parseAction,
  planWave,
  quote,
  slotsUnlocked,
  trophyStake,
  weakerFactor,
} from '../src/index.ts';

const world = getWorld();
const plot = world.plots[27]!;

describe('layout & world', () => {
  it('has a closed wall ring and slots inside it', () => {
    expect(WALLS.length).toBe(36);
    expect(new Set(WALLS.map((w) => `${w.x},${w.y}`)).size).toBe(WALLS.length);
    expect(SLOTS).toHaveLength(8);
  });

  it('is identical every time it is generated (server and clients agree)', () => {
    const a = generateWorld(123);
    const b = generateWorld(123);
    expect(a.plots).toEqual(b.plots);
    expect(a.props).toEqual(b.props);
    expect(a.graveyards).toEqual(b.graveyards);
  });

  it('has 64 non-overlapping plots and a graveyard serving 3-5 bases each', () => {
    expect(world.plots).toHaveLength(64);
    for (const a of world.plots)
      for (const b of world.plots)
        if (a.id < b.id) expect(a.x < b.x + PLOT && b.x < a.x + PLOT && a.y < b.y + PLOT && b.y < a.y + PLOT).toBe(false);
    for (const g of world.graveyards) {
      expect(g.serves.length).toBeGreaterThanOrEqual(3);
      expect(g.serves.length).toBeLessThanOrEqual(5);
      expect(g.graves.length).toBeGreaterThanOrEqual(6);
      expect(g.graves.length).toBeLessThanOrEqual(10);
    }
    expect(new Set(world.plots.map((p) => p.order)).size).toBe(64);
  });

  it('only allows deploying on the apron outside the walls', () => {
    expect(inDeployZone(0, 0)).toBe(true);
    expect(inDeployZone(13, 7)).toBe(true);
    expect(inDeployZone(6, 6)).toBe(false); // inside the compound
    expect(inDeployZone(2, 5)).toBe(false); // on the wall
    expect(inDeployZone(14, 3)).toBe(false); // outside the plot
  });
});

describe('zombie waves', () => {
  it('are deterministic: same base + seed + plot = same wave', () => {
    for (let seed = 1; seed < 20; seed++) {
      const a = new ZombieWave(newBase(), seed, plot);
      const b = new ZombieWave(newBase(), seed, plot);
      a.runToEnd();
      b.runToEnd();
      expect([a.kills, a.coins, a.breached, a.combat.tick]).toEqual([b.kills, b.coins, b.breached, b.combat.tick]);
      expect(a.combat.snapshot(true)).toEqual(b.combat.snapshot(true));
    }
  });

  it("rise from the graves of the base's own graveyard", () => {
    const plan = planWave(3, 99, plot);
    const gy = world.graveyards[plot.graveyard]!;
    expect(plan.graveyard).toBe(gy.id);
    for (const s of plan.spawns) expect(gy.graves.some((g) => Math.abs(g.x + 0.5 - s.x) < 1e-9 && Math.abs(g.y + 0.85 - s.y) < 1e-9)).toBe(true);
  });

  it('zombies are harmless while rising, then walk to their base', () => {
    const w = new ZombieWave(newBase(), 5, plot);
    while (w.combat.units.length === 0) w.step();
    const u = w.combat.units[0]!;
    expect(u.state).toBe('rise');
    for (let i = 0; i < 40; i++) w.step();
    expect(['move', 'attack']).toContain(w.combat.units[0]!.state);
  });

  it('always end within the time limit', () => {
    for (let seed = 1; seed < 30; seed++) {
      const w = new ZombieWave(newBase(), seed, world.plots[seed]!);
      w.runToEnd();
      expect(w.combat.tick).toBeLessThanOrEqual(CONFIG.waves.maxDuration * CONFIG.tickRate);
    }
  });

  it('a base with no posts gets breached by a big wave', () => {
    const base = { hq: 6, walls: 1, posts: SLOTS.map(() => null) };
    let breaches = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const w = new ZombieWave(base, seed, plot);
      w.runToEnd();
      if (w.breached) breaches++;
    }
    expect(breaches).toBeGreaterThan(10);
  });
});

describe('raids', () => {
  it('deploys only on the apron, then plays out deterministically', () => {
    const play = () => {
      const r = new Raid(1, plot, newBase(), 1, 42);
      expect(r.canDeploy('r_bat', plot.x + 7, plot.y + 7)).toMatch(/outside the walls/);
      expect(r.canDeploy('r_helmet', plot.x + 0.5, plot.y + 0.5)).toMatch(/Main Tower level 3/);
      for (let i = 0; i < 8; i++) {
        expect(r.canDeploy('r_bat', plot.x + 0.5, plot.y + 0.5 + i * 0.3)).toBeNull();
        r.deploy('r_bat', plot.x + 0.5, plot.y + 0.5 + i * 0.3);
      }
      while (!r.done) r.step();
      return [r.won, r.endReason, r.combat.tick, r.combat.destruction()];
    };
    expect(play()).toEqual(play());
  });

  it('ends on time even with nothing deployed', () => {
    const r = new Raid(1, plot, newBase(), 1, 1);
    while (!r.done) r.step();
    expect(r.won).toBe(false);
    expect(r.endReason).toBe('idle');
  });

  it('loot and trophies are capped and shrink against much weaker players', () => {
    expect(lootable(50, 1)).toBe(0); // protected floor
    expect(lootable(1000, 1)).toBe(200);
    expect(lootable(1_000_000, 2)).toBe(CONFIG.pvp.loot.capBase + 2 * CONFIG.pvp.loot.capPerHq);
    expect(weakerFactor(100, 100)).toBe(1);
    expect(weakerFactor(1000, 100)).toBe(CONFIG.pvp.weaker.min);
    expect(trophyStake(100, 100)).toBe(CONFIG.pvp.trophies.base);
    expect(trophyStake(1000, 0)).toBeLessThan(trophyStake(100, 100));
    expect(trophyStake(0, 1000)).toBe(CONFIG.pvp.trophies.max);
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

describe('crate rules', () => {
  const q = { id: 'x', prompt: '', code: '', lang: 'c', kind: 'fill-blank', answers: ['<= +=1', '%d'], difficulty: 1 };

  it('normalises answers leniently but not loosely', () => {
    expect(checkAnswer(q, ' <=  += 1 ')).toBe(true);
    expect(checkAnswer(q, '"%D";')).toBe(true);
    expect(checkAnswer(q, '<=,+=1')).toBe(true);
    expect(checkAnswer(q, '%s')).toBe(false);
    expect(checkAnswer(q, '')).toBe(false);
    const out = { ...q, kind: 'predict-output', answers: ['4 4'] };
    expect(checkAnswer(out, '4, 4')).toBe(true);
    expect(checkAnswer(out, '44')).toBe(false);
  });

  it('rolls rarities by weight', () => {
    const n = { rare: 0, epic: 0, legendary: 0 };
    for (let i = 0; i < 1000; i++) n[rollRarity(i / 1000)]++;
    expect(n).toEqual({ rare: 600, epic: 300, legendary: 100 });
  });

  it('a stronger boost replaces a weaker one; a weaker crate never downgrades', () => {
    const now = 1000;
    const strong = { attack: { pct: 0.6, uses: 3 }, defence: { pct: 0.6, until: now + 1e6 }, loot: { pct: 1, uses: 1 } };
    const g = grantCrate(strong, 'rare', now, 0.5);
    expect(g.type).toBeUndefined();
    expect(g.coins).toBe(CONFIG.crates.consolation.rare);
    expect(g.boosts).toEqual(strong);
    const g2 = grantCrate({ attack: { pct: 0.25, uses: 1 } }, 'legendary', now, 0);
    expect(g2.boosts.attack).toEqual({ pct: 0.6, uses: CONFIG.crates.boosts.attack.uses });
    // An expired boost doesn't block anything.
    const g3 = grantCrate({ defence: { pct: 0.6, until: now - 1 } }, 'rare', now, 0.4);
    expect(g3.type).toBe('defence');
  });

  it('a defence boost raises post damage and health in combat', () => {
    const base = newBase();
    const plain = baseBuildings(base, { x: 0, y: 0 }).find((b) => b.kind === 'post')!;
    const boosted = baseBuildings(base, { x: 0, y: 0 }, 0.4).find((b) => b.kind === 'post')!;
    expect(boosted.hp).toBe(Math.round(plain.hp * 1.4));
    expect(boosted.gun!.damage).toBe(Math.round(plain.gun!.damage * 1.4));
  });
});
