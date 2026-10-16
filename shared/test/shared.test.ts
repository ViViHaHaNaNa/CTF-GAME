import { describe, expect, it } from 'vitest';
import {
  CONFIG,
  PLOT,
  PROP_FILES,
  SLOTS,
  WALLS,
  Combat,
  Raid,
  Siege,
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
  killCoins,
  mulberry32,
  newDirector,
  firepower,
  postId,
  type SiegeEvent,
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

describe('zombie siege', () => {
  const rate = CONFIG.tickRate;
  /** Run a siege, collecting its events. */
  const play = (s: Siege, secs: number) => {
    const events: SiegeEvent[] = [];
    for (let t = 0; t < secs * s.combat.rate; t++) {
      s.step();
      events.push(...s.events);
      s.events.length = 0;
    }
    return events;
  };

  it('is deterministic: same base + plot + seed + director = same siege', () => {
    for (let seed = 1; seed < 6; seed++) {
      const a = new Siege(newBase(), plot, seed, newDirector());
      const b = new Siege(newBase(), plot, seed, newDirector());
      expect(play(a, 60)).toEqual(play(b, 60));
      expect([a.kills, a.coins, a.breaches]).toEqual([b.kills, b.coins, b.breaches]);
      expect(a.combat.snapshot(true)).toEqual(b.combat.snapshot(true));
    }
  });

  it('bursts in from all four sides and the graveyard within seconds, no countdown', () => {
    const s = new Siege(newBase(), plot, 7, newDirector());
    const events = play(s, CONFIG.siege.firstSurge + 0.5);
    const first = events.find((e) => e.type === 'surge');
    expect(first).toMatchObject({ type: 'surge', n: 1, size: CONFIG.siege.ramp[0]!.size, pincer: false });
    if (first?.type === 'surge') for (const n of first.sides) expect(n).toBeGreaterThan(0);
    expect(s.combat.liveUnits).toBeGreaterThanOrEqual(5);
  });

  it('spawns hug their own plot: never inside another compound', () => {
    for (const p of [world.plots[0]!, world.plots[27]!, world.plots[63]!]) {
      const s = new Siege(newBase(), p, 3, { ...newDirector(), played: 600 }, { ramp: false, firstDelay: 0 });
      const seen = new Set<number>();
      for (let t = 0; t < 40 * rate; t++) {
        s.step();
        for (const u of s.combat.units) {
          if (seen.has(u.id)) continue;
          seen.add(u.id);
          for (const o of world.plots) if (o.id !== p.id) expect(u.x >= o.x && u.x < o.x + PLOT && u.y >= o.y && u.y < o.y + PLOT).toBe(false);
        }
      }
      expect(seen.size).toBeGreaterThan(20);
    }
  });

  it('the first surge is always held, and the first minute ramps up', () => {
    for (let seed = 1; seed <= 16; seed++) {
      const events = play(new Siege(newBase(), world.plots[seed * 3]!, seed, newDirector()), 60);
      expect(events.find((e) => e.type !== 'surge')).toMatchObject({ type: 'held', n: 1 });
      const sizes = events.flatMap((e) => (e.type === 'surge' ? [e.size] : []));
      expect(sizes.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
    }
  });

  it('keeps a rhythm: short breathers with a trickle, then pincers', () => {
    const base = applyAction(newBase(), { kind: 'build', slot: 1, type: 'pistol' });
    const s = new Siege(base, plot, 11, newDirector());
    let trickle = 0;
    const events: SiegeEvent[] = [];
    let ended = -1;
    const gaps: number[] = [];
    for (let t = 0; t < 180 * rate; t++) {
      s.step();
      for (const e of s.events) {
        if (e.type !== 'surge') ended = t;
        else if (ended >= 0) gaps.push((t - ended) / rate);
      }
      events.push(...s.events);
      s.events.length = 0;
      trickle = Math.max(trickle, s.combat.units.filter((u) => u.tag === 0 && u.state !== 'dead').length);
    }
    expect(trickle).toBeGreaterThan(0);
    // After the ramp, every breather is 3-5 s (or the longer one after a breach).
    for (const g of gaps.slice(CONFIG.siege.ramp.length)) {
      expect(g).toBeGreaterThanOrEqual(CONFIG.siege.breather[0] - 0.1);
      expect(g).toBeLessThanOrEqual(Math.max(CONFIG.siege.breather[1], CONFIG.siege.breach.breather) + 0.1);
    }
    const pincers = events.filter((e) => e.type === 'surge' && e.pincer);
    expect(pincers.length).toBeGreaterThan(2);
    for (const e of pincers) if (e.type === 'surge') expect(e.n).toBeGreaterThanOrEqual(CONFIG.siege.pincerFrom);
  });

  it('a base with no posts gets breached: the field clears, the director eases off, the siege goes on', () => {
    const base = { hq: 3, walls: 1, posts: SLOTS.map(() => null) };
    const d = { ...newDirector(), played: 600 };
    const s = new Siege(base, plot, 5, d, { ramp: false, firstDelay: 0 });
    let breach = -1;
    for (let t = 0; t < 120 * rate && breach < 0; t++) {
      s.step();
      if (s.events.some((e) => e.type === 'breach')) breach = t;
      s.events.length = 0;
    }
    expect(breach).toBeGreaterThan(0);
    expect(d.pressure).toBeLessThan(CONFIG.siege.difficulty.start);
    expect(s.combat.liveUnits).toBe(0);
    expect(s.combat.hqDestroyed).toBe(false);
    play(s, CONFIG.siege.breach.breather + 1);
    expect(s.combat.liveUnits).toBeGreaterThan(0);
  });

  it('a breach costs a capped share and never goes below the protected floor', () => {
    const { lossPct, maxLoss, protectedFloor } = CONFIG.siege.breach;
    expect(breachLoss(50)).toBe(0);
    expect(breachLoss(protectedFloor + 5)).toBeLessThanOrEqual(5);
    expect(breachLoss(1000)).toBe(Math.min(maxLoss, Math.round(1000 * lossPct)));
    expect(breachLoss(1_000_000)).toBe(maxLoss);
  });

  it('upgrades join the running fight at once', () => {
    const s = new Siege(newBase(), plot, 2, newDirector());
    play(s, 5);
    expect(s.combat.buildings.has(postId(1))).toBe(false);
    s.setBase(applyAction(newBase(), { kind: 'build', slot: 1, type: 'pistol' }));
    expect(s.combat.buildings.get(postId(1))?.alive).toBe(true);
  });

  it('every post covers every wall during a siege (raids keep the plain ranges)', () => {
    const base = applyAction(applyAction(applyAction(newBase(), { kind: 'hq' }), { kind: 'hq' }), { kind: 'build', slot: 1, type: 'shotgun' });
    const siege = baseBuildings(base, plot, 0, true);
    const walls = siege.filter((b) => b.kind === 'wall');
    for (const p of siege.filter((b) => b.gun)) for (const w of walls) expect(Math.hypot(w.x - p.x, w.y - p.y)).toBeLessThanOrEqual(p.gun!.range);
    expect(baseBuildings(base, plot).find((b) => b.id === postId(1))!.gun!.range).toBe(CONFIG.posts.types.shotgun.range);
  });

  it('smalls die to one or two shots from a starter pistol and are worth exactly 1 coin', () => {
    expect(Math.ceil(CONFIG.zombies.z_small.hp / CONFIG.posts.types.pistol.damage)).toBeLessThanOrEqual(2);
    expect(killCoins('z_small', 1)).toBe(1);
    expect(killCoins('z_small', 8)).toBe(1);
  });

  it('posts pick exactly the target a full scan would (spatial hash)', () => {
    const c = new Combat(9, baseBuildings(newBase(), plot), { crowd: true });
    const rng = mulberry32(4);
    const stats = { hp: 10, speed: 1, damage: 1, cooldown: 1, range: 0.5, wallMult: 1 };
    for (let i = 0; i < 150; i++) c.addUnit(0, stats, plot.x - 6 + rng() * (PLOT + 12), plot.y - 6 + rng() * (PLOT + 12), i % 7 === 0 ? 5 : 0);
    // Duplicate positions to exercise tie-breaking.
    for (let i = 0; i < 10; i++) c.addUnit(0, stats, c.units[i]!.x, c.units[i]!.y);
    const priv = c as unknown as { rehash(): void; nearest(x: number, y: number, r: number): unknown };
    priv.rehash();
    for (let k = 0; k < 300; k++) {
      const x = plot.x - 8 + rng() * (PLOT + 16);
      const y = plot.y - 8 + rng() * (PLOT + 16);
      const r = 1 + rng() * 10;
      let best: unknown;
      let bestD = Infinity;
      for (const u of c.units) {
        if (u.state === 'dead' || u.state === 'rise') continue;
        const d = Math.hypot(u.x - x, u.y - y);
        if (d <= r && d < bestD) (best = u), (bestD = d);
      }
      expect(priv.nearest(x, y, r)).toBe(best);
    }
  });

  it('firepower grows with posts', () => {
    const one = firepower(newBase());
    expect(firepower(applyAction(newBase(), { kind: 'build', slot: 1, type: 'pistol' }))).toBeCloseTo(one * 2);
    expect(firepower({ hq: 1, walls: 1, posts: SLOTS.map(() => null) })).toBe(0);
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

describe('scenery', () => {
  it('every prop points at a registered image', () => {
    for (const pr of world.props) {
      expect(pr.f).toBeGreaterThanOrEqual(0);
      expect(PROP_FILES[pr.f]).toBeTypeOf('string');
    }
  });
});
