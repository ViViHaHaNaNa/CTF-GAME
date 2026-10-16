import { describe, expect, it } from 'vitest';
import {
  CONFIG,
  PLOT,
  PROP_FILES,
  SLOTS,
  WALLS,
  Combat,
  Raid,
  raidLoot,
  raidStars,
  raidTrophies,
  type RaiderKind,
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
  surgePower,
  rampGrowth,
  defenceRating,
  basicBaseDone,
  type BaseAction,
  mulberry32,
  newDirector,
  firepower,
  postId,
  type SiegeEvent,
  type TapResult,
  type ZombieKind,
  UNIT_KINDS,
  commanderSpot,
  inOtherPlot,
  inTapReach,
  tapDpsCap,
  zombieStats,
  quote,
  slotsUnlocked,
  trophyStake,
  matchFactor,
  starBonus,
  vaultCapacity,
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

  it("a new player's first surge is a walkthrough: 8 Smalls from one side, and it can't be lost", () => {
    // No posts at all: still held, the Main Tower can't drop below its floor.
    const base = { ...newBase(), posts: SLOTS.map(() => null) };
    const s = new Siege(base, plot, 7, newDirector());
    expect(s.tutorial).toBe(true);
    expect(s.incoming).toHaveLength(1);
    const events = play(s, CONFIG.siege.firstSurge + CONFIG.siege.maxSurge + 2);
    const first = events.find((e) => e.type === 'surge');
    expect(first).toMatchObject({ type: 'surge', n: 1, size: CONFIG.siege.tutorial.size, tutorial: true, boss: false });
    if (first?.type === 'surge') expect(first.sides.filter((n) => n > 0)).toHaveLength(1);
    expect(events.find((e) => e.type !== 'surge')).toMatchObject({ type: 'held', n: 1 });
    expect(s.combat.hq!.hp).toBeGreaterThanOrEqual(Math.round(s.combat.hq!.maxHp * CONFIG.siege.tutorial.hqFloor));
    expect(s.tutorial).toBe(false);
    // Only once: a player who has had surges gets no walkthrough.
    expect(new Siege(base, plot, 7, { ...newDirector(), surges: 3 }).tutorial).toBe(false);
  });

  it('every live surge is stronger than the last, whatever happens in it; offline surges leave the ramp alone', () => {
    const R = CONFIG.siege.ramp;
    // A built base (guidance over) that loses some and wins some: the ramp grows by the same factor each time.
    const base = { hq: 3, walls: 3, cmd: 0, posts: SLOTS.map((_, i) => (i < 4 ? { type: 'gun' as const, level: 3 } : null)) };
    const d = { ...newDirector(), surges: 5 };
    const s = new Siege(base, plot, 9, d, { firstDelay: 0 });
    const ramps: number[] = [];
    for (let k = 0; k < 6; k++) {
      s.runSurge();
      ramps.push(d.ramp);
    }
    for (let k = 1; k < ramps.length; k++) expect(ramps[k]! / ramps[k - 1]!).toBeCloseTo(rampGrowth(6 + k), 5);
    const offline = new Siege(base, plot, 9, d, { coarse: true, ramp: false, firstDelay: 0 });
    offline.counting = false;
    const before = d.ramp;
    offline.runSurge();
    expect(d.ramp).toBe(before);
  });

  it('the surge power is spent on more zombies first, then tougher ones; hordes every few surges', () => {
    const R = CONFIG.siege.ramp;
    expect(surgePower(1)).toEqual({ power: R.start, count: R.start, toughness: 1 });
    expect(surgePower(R.countCap * 2)).toMatchObject({ count: R.start * R.countCap, toughness: 2 });
    expect(killCoins('z_big', 2)).toBe(Math.round(2 * CONFIG.siege.power.z_big * CONFIG.siege.coinsPerPower));
    const base = { hq: 4, walls: 4, cmd: 0, posts: SLOTS.map((_, i) => (i < 5 ? { type: 'gun' as const, level: 4 } : null)) };
    const d = { ...newDirector(), surges: 1 };
    const s = new Siege(base, plot, 3, d, { firstDelay: 0 });
    const hordes: number[] = [];
    for (let k = 0; k < 10; k++) {
      const next = s.threat();
      s.runSurge();
      if (next.horde) hordes.push(d.surges);
    }
    // Every `hordeEvery`th surge the player has ever had is a horde.
    expect(hordes.length).toBe(2);
    for (const n of hordes) expect(n % CONFIG.siege.hordeEvery).toBe(0);
  });

  it('guidance: one side, gentler, no hordes, hints, until the basic base is built; then the full ramp at once', () => {
    let base = newBase();
    const d = { ...newDirector(), surges: 1, ramp: 20 };
    const s = new Siege(base, plot, 4, d, { firstDelay: 0 });
    expect(s.guided).toBe(true);
    expect(s.incoming).toHaveLength(1);
    // The guided ramp is capped.
    expect(s.threat().next).toBeLessThanOrEqual(Math.ceil(CONFIG.siege.ramp.start * CONFIG.siege.guided.maxRamp * (1 + CONFIG.siege.variance)));
    for (const a of [{ kind: 'build', slot: 1, type: 'pistol' }, { kind: 'hq' }, { kind: 'post', slot: 0 }, { kind: 'walls' }] as BaseAction[]) {
      expect(s.guided).toBe(true);
      base = applyAction(base, a);
      s.setBase(base);
    }
    expect(basicBaseDone(base)).toBe(true);
    expect(s.guided).toBe(false);
    expect(s.incoming.length).toBe(CONFIG.siege.sides[1]);
    expect(s.threat().next).toBeGreaterThan(CONFIG.siege.ramp.start * CONFIG.siege.guided.maxRamp * (1 + CONFIG.siege.variance));
  });

  it('the threat meter compares the defence with the next surge', () => {
    const s = new Siege(newBase(), plot, 1, { ...newDirector(), surges: 1 }, { firstDelay: 0 });
    const t = s.threat();
    expect(t.defence).toBe(defenceRating(newBase()));
    expect(t.next).toBeGreaterThan(0);
    const two = applyAction(newBase(), { kind: 'build', slot: 1, type: 'pistol' });
    expect(defenceRating(two)).toBeGreaterThan(t.defence);
  });

  it('aim assist in the walkthrough surge only', () => {
    const C = CONFIG.commander;
    const r = (C.hitRadius + C.hitRadiusGuided) / 2;
    for (const [surges, hit] of [[0, true], [1, false]] as const) {
      const s = new Siege(newBase(), plot, 1, { ...newDirector(), surges }, { firstDelay: 999 });
      const u = s.combat.addUnit(0, { ...zombieStats('z_small'), speed: 0 }, plot.x + 7, plot.y + 1);
      const t = s.tap(u.x + r, u.y);
      expect(t.ok && t.hits.length > 0).toBe(hit);
    }
  });

  it('surges come on a regular countdown that grows with level, with nothing in between', () => {
    for (const hq of [1, 3, 6]) {
      const base = { ...newBase(), hq, walls: hq, posts: SLOTS.map((_, i) => (i < 4 ? { type: 'gun' as const, level: hq } : null)) };
      const s = new Siege(base, plot, 5, { ...newDirector(), surges: 9 }, { firstDelay: 0 });
      let ended = -1;
      const gaps: number[] = [];
      let strays = 0;
      // No new zombie appears during a countdown (stragglers from a surge that ran long may finish walking in).
      let known = new Set<number>();
      for (let t = 0; t < (2 * CONFIG.siege.gap[hq - 1]! + 3 * CONFIG.siege.maxSurge) * rate; t++) {
        s.step();
        for (const e of s.events) {
          if (e.type === 'held' || e.type === 'breach') (ended = s.combat.tick), (known = new Set(s.combat.units.map((u) => u.id)));
          if (e.type === 'surge' && ended >= 0) gaps.push((s.combat.tick - ended) / rate);
        }
        s.events.length = 0;
        if (s.phase === 'breather') for (const u of s.combat.units) if (!known.has(u.id)) strays++;
      }
      expect(gaps.length).toBeGreaterThan(0);
      for (const g of gaps) expect(g).toBeCloseTo(CONFIG.siege.gap[hq - 1]!, 0);
      expect(strays).toBe(0);
    }
  });

  it('calling a surge early pays for the time skipped, once enough of the countdown has passed', () => {
    const E = CONFIG.siege.callEarly;
    const gap = CONFIG.siege.gap[0]!;
    const s = new Siege(newBase(), plot, 2, { ...newDirector(), surges: 9 }, { firstDelay: 0 });
    while (s.phase !== 'breather') s.step();
    expect(s.callEarly()).toBe(0); // too soon
    while (s.nextIn() > gap * (1 - E.minWait)) s.step();
    const left = s.nextIn();
    const bonus = s.callEarly();
    expect(bonus).toBe(Math.round(left * E.perSecond[0]!));
    s.step();
    expect(s.phase).toBe('surge');
    expect(s.callEarly()).toBe(0);
  });

  it('spawns hug their own plot: never inside another compound', () => {
    for (const p of [world.plots[0]!, world.plots[27]!, world.plots[63]!]) {
      const base = { ...newBase(), hq: 4, walls: 4, posts: SLOTS.map((_, i) => (i < 3 ? { type: 'gun' as const, level: 3 } : null)) };
      const s = new Siege(base, p, 3, { ...newDirector(), played: 600, surges: 5, ramp: 3 }, { ramp: false, firstDelay: 0 });
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

  it('a base with no posts gets breached: the field clears, the ramp still grows, the siege goes on', () => {
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
    // No easing: the ramp grows after a lost surge too.
    expect(d.ramp).toBeGreaterThan(1);
    expect(s.combat.liveUnits).toBe(0);
    expect(s.combat.hqDestroyed).toBe(false);
    // ...and the countdown to the next surge starts.
    expect(s.phase).toBe('breather');
    play(s, CONFIG.siege.gap[2]! + 2);
    expect(s.combat.liveUnits).toBeGreaterThan(0);
  });

  it('a breach costs a capped share and never goes below the protected floor', () => {
    const { lossPct, maxLoss, protectedFloor } = CONFIG.siege.breach;
    expect(breachLoss(50, 1)).toBe(0);
    expect(breachLoss(protectedFloor + 5, 1)).toBeLessThanOrEqual(5);
    expect(breachLoss(1000, 8)).toBe(Math.min(maxLoss[7]!, Math.round(1000 * lossPct)));
    expect(breachLoss(1_000_000, 1)).toBe(maxLoss[0]);
    expect(breachLoss(1_000_000, 8)).toBe(maxLoss[7]);
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

  it('smalls die to one or two shots from a starter pistol; kills pay by zombie power', () => {
    expect(Math.ceil(CONFIG.zombies.z_small.hp / CONFIG.posts.types.pistol.damage)).toBeLessThanOrEqual(2);
    expect(killCoins('z_small')).toBe(Math.round(CONFIG.siege.power.z_small * CONFIG.siege.coinsPerPower));
    expect(killCoins('z_big')).toBe(Math.round(CONFIG.siege.power.z_big * CONFIG.siege.coinsPerPower));
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

describe('commander (tap-to-attack)', () => {
  const rate = CONFIG.tickRate;
  const C = CONFIG.commander;
  /** A siege with a few still zombies placed by hand (no surges for a while). */
  const range = (base = newBase()) => {
    const s = new Siege(base, plot, 1, newDirector(), { firstDelay: 999 });
    const z = (x: number, y: number, kind: ZombieKind = 'z_small') => s.combat.addUnit(UNIT_KINDS.indexOf(kind), { ...zombieStats(kind, base.hq), speed: 0 }, x, y);
    return { s, z, wait: (secs: number) => { for (let i = 0; i < secs * rate; i++) s.step(); } };
  };

  it('hits the zombie closest to the tap point, anywhere around the base (360 degrees, past the walls)', () => {
    const { s, z } = range();
    const far = z(plot.x - 3, plot.y + 7); // out on the street to the west
    const a = z(plot.x + 12.5, plot.y + 3);
    const b = z(plot.x + 13.2, plot.y + 3); // overlapping clump: the closer one to the tap is hit
    const r = s.tap(plot.x + 13.1, plot.y + 3.1);
    expect(r.ok && r.hits.length).toBe(1);
    expect(b.hp).toBeLessThan(b.maxHp);
    expect(a.hp).toBe(a.maxHp);
    s.combat.tick += 10;
    const r2 = s.tap(plot.x - 2.5, plot.y + 7.5);
    expect(r2.ok && r2.hits.length).toBe(1);
    expect(far.hp).toBeLessThan(far.maxHp);
  });

  it('a tap on empty ground still flies toward the point and hits a zombie near its path', () => {
    const { s, z } = range();
    const [cx, cy] = commanderSpot(plot);
    const onPath = z(cx + 4, cy - 0.6);
    const r = s.tap(cx + 9, cy - 0.6);
    expect(r.ok && r.hits.length).toBe(1);
    expect(onPath.hp).toBeLessThan(onPath.maxHp);
    s.combat.tick += 10;
    const miss = s.tap(cx + 9, cy + 6);
    expect(miss.ok && miss.hits.length).toBe(0);
  });

  it('enforces the fire rate, the magazine and the reload', () => {
    const { s, z } = range();
    z(plot.x + 7, plot.y + 1);
    const w = C.weapons.pistol;
    expect(s.tap(plot.x + 7, plot.y + 1).ok).toBe(true);
    expect(s.tap(plot.x + 7, plot.y + 1)).toMatchObject({ ok: false, error: 'too fast' });
    let fired = 1;
    for (let t = 0; t < 10 * rate && fired < w.magazine; t++) {
      s.combat.tick++;
      if (s.tap(plot.x + 7, plot.y + 1).ok) fired++;
    }
    expect(fired).toBe(w.magazine);
    const empty = s.tap(plot.x + 7, plot.y + 1);
    expect(empty).toMatchObject({ ok: false, error: 'reloading' });
    s.combat.tick += Math.ceil(w.reload * rate);
    expect(s.tap(plot.x + 7, plot.y + 1).ok).toBe(true);
  });

  it('an autoclicker at the full fire rate never deals more than the tap damage cap', () => {
    const { s, z } = range();
    for (let i = 0; i < 40; i++) z(plot.x + 2 + (i % 10), plot.y + 1 + Math.floor(i / 10) * 0.4, 'z_big');
    let dealt = 0;
    const secs = 20;
    for (let t = 0; t < secs * rate; t++) {
      const r = s.tap(plot.x + 6, plot.y + 1.5);
      if (r.ok) for (const h of r.hits) dealt += h[2];
      s.combat.tick++;
    }
    const cap = tapDpsCap(newBase());
    expect(dealt).toBeLessThanOrEqual(cap * (secs + C.dpsCap.burst) + 20);
    expect(dealt).toBeGreaterThan(cap * secs * 0.6);
  });

  it('the shotgun spreads pellets over the clump', () => {
    const base = { ...newBase(), hq: 3, cmd: 2 };
    const { s, z } = range(base);
    const pack = [z(plot.x + 12.5, plot.y + 5), z(plot.x + 12.9, plot.y + 5.4), z(plot.x + 12.3, plot.y + 5.6), z(plot.x + 13.1, plot.y + 4.8)];
    const r = s.tap(plot.x + 12.5, plot.y + 5);
    expect(r.ok && r.hits.length).toBe(C.weapons.shotgun.pellets);
    expect(pack.filter((u) => u.hp < u.maxHp).length).toBeGreaterThanOrEqual(3);
  });

  it('kills in a row build a combo that pays bonus coins; a miss resets it', () => {
    const { s, z } = range();
    let last: TapResult | undefined;
    for (let i = 0; i < C.combo.step + 1; i++) {
      const u = z(plot.x + 3 + i * 0.1, plot.y + 1);
      while (u.state !== 'dead') {
        s.combat.tick += 5;
        const r = s.tap(u.x, u.y);
        if (r.ok) last = r;
        else s.combat.tick += rate * 2;
      }
    }
    expect(last!.combo).toBe(C.combo.step + 1);
    expect(last!.mult).toBe(2);
    expect(last!.bonus).toBeGreaterThan(0);
    s.combat.tick += 5;
    const miss = s.tap(plot.x + 7, plot.y + 13);
    expect(miss.ok && miss.combo).toBe(0);
  });

  it('an airstrike clears a clump after its warning, then needs its cooldown', () => {
    // No posts, so only the airstrike can kill them.
    const { s, z, wait } = range({ ...newBase(), posts: SLOTS.map(() => null) });
    const clump = Array.from({ length: 12 }, (_, i) => z(plot.x + 11 + (i % 4) * 0.5, plot.y + 2 + Math.floor(i / 4) * 0.5));
    expect(s.airstrike(plot.x + 11.8, plot.y + 2.5).ok).toBe(true);
    expect(s.airstrike(plot.x + 11.8, plot.y + 2.5).ok).toBe(false);
    wait(C.airstrike.delay - 0.2);
    expect(clump.every((u) => u.state !== 'dead')).toBe(true);
    wait(0.4);
    expect(clump.every((u) => u.state === 'dead')).toBe(true);
    expect(s.events.some((e) => e.type === 'strike' && e.kills === 12)).toBe(true);
  });

  it('weapons unlock with Main Tower level and cost coins', () => {
    expect(quote(newBase(), { kind: 'commander' })).toMatchObject({ ok: false, reason: expect.stringMatching(/Main Tower level 2/) });
    const hq2 = { ...newBase(), hq: 2 };
    expect(quote(hq2, { kind: 'commander' })).toEqual({ ok: true, cost: C.weapons.gun.cost });
    const gun = applyAction(hq2, { kind: 'commander' });
    expect(gun.cmd).toBe(1);
    expect(quote(gun, { kind: 'commander' }).ok).toBe(false);
    expect(quote({ ...gun, hq: 3 }, { kind: 'commander' })).toEqual({ ok: true, cost: C.weapons.shotgun.cost });
    // Taps reach `reach` tiles around the plot (zombies jostled into an alley can still be shot)...
    expect(inTapReach(plot, plot.x + PLOT + C.reach - 0.5, plot.y + 7)).toBe(true);
    expect(inTapReach(plot, plot.x + PLOT + C.reach + 0.5, plot.y + 7)).toBe(false);
    // ...and the client knows when a tap lands on a neighbour's plot (plot 27: street east, alley west).
    expect(inOtherPlot(plot, plot.x + PLOT + 3.5, plot.y + 7)).toBe(false);
    expect(inOtherPlot(plot, plot.x + PLOT + 4.5, plot.y + 7)).toBe(true);
    expect(inOtherPlot(plot, plot.x - 3, plot.y + 7)).toBe(true);
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
      while (!r.done) r.step(false);
      return [r.won, r.stars, r.endReason, r.combat.tick, r.combat.destruction()];
    };
    expect(play()).toEqual(play());
  });

  const rate = CONFIG.tickRate;
  const S = CONFIG.pvp.stall;
  const noPosts = () => ({ ...newBase(), posts: SLOTS.map(() => null) });
  /** A raider with custom damage, dropped on the apron. */
  const drop = (r: Raid, damage: number, kind: RaiderKind = 'r_bat', at = 0.5) => {
    r.deploy(kind, plot.x + at, plot.y + 0.5);
    r.combat.units.at(-1)!.stats = { ...r.combat.units.at(-1)!.stats, damage };
  };

  it('has no countdown: it keeps going while damage is being dealt, past 50%, until everything is down', () => {
    const r = new Raid(1, plot, newBase(), 3, 7);
    for (let i = 0; i < 20; i++) r.deploy('r_helmet', plot.x + 0.5 + (i % 5) * 0.5, plot.y + 0.5 + Math.floor(i / 5) * 0.4);
    // The old rules ended a raid at 50% (or the Main Tower); now it carries on.
    let halfAt = -1;
    while (!r.done) {
      r.step(false);
      if (halfAt < 0 && r.destruction() >= 0.5) halfAt = r.combat.tick;
    }
    expect(halfAt).toBeGreaterThan(0);
    expect(r.combat.tick).toBeGreaterThan(halfAt);
    expect(r.combat.hqDestroyed).toBe(true);
    expect(r.endReason).toBe('cleared');
    expect(r.stars).toBe(3);
    expect(r.vaultDown()).toBe(true);
  });

  it('nothing deployed for 30 s: cancelled', () => {
    const r = new Raid(1, plot, newBase(), 1, 1);
    while (!r.done) r.step();
    expect(r.endReason).toBe('cancelled');
    expect(r.combat.tick).toBe(S.noDeploy * rate);
    expect(r.won).toBe(false);
  });

  it('nobody dealing damage for 15 s after the first deploy ends it', () => {
    const r = new Raid(1, plot, noPosts(), 1, 1);
    drop(r, 0);
    while (!r.done) r.step();
    expect(r.endReason).toBe('stall');
    expect(r.combat.tick).toBeLessThanOrEqual(S.noDamage * rate + 2);
  });

  it('every raider dead and nothing left to send ends it; with army left it waits (until the stall rule)', () => {
    const fight = (armyLeft: boolean) => {
      const r = new Raid(1, plot, newBase(), 1, 3);
      r.deploy('r_bat', plot.x + 0.5, plot.y + 0.5);
      while (!r.done) r.step(armyLeft);
      return r;
    };
    expect(fight(false).endReason).toBe('army');
    expect(fight(true).endReason).toBe('stall');
  });

  it('a hidden failsafe ends any raid after 6 minutes', () => {
    const r = new Raid(1, plot, { ...noPosts(), walls: 8 }, 1, 1);
    drop(r, 1);
    while (!r.done) r.step();
    expect(r.endReason).toBe('failsafe');
    expect(r.combat.tick).toBe(S.failsafe * rate);
  });

  it('raiders never stand idle: always walking to a target or hitting one', () => {
    const r = new Raid(1, plot, newBase(), 4, 5);
    for (const [i, k] of (['r_bat', 'r_pistol', 'r_helmet', 'r_shotgun'] as RaiderKind[]).entries()) r.deploy(k, plot.x + 0.5 + i, plot.y + 0.5);
    const seen = new Map<number, { x: number; y: number; t: number }>();
    for (let t = 0; t < 60 * rate && !r.done; t++) {
      r.step(false);
      for (const u of r.combat.units) {
        if (u.state === 'dead') continue;
        expect(['move', 'attack']).toContain(u.state);
        expect(u.targetId).toBeGreaterThan(0);
        // A walking unit makes progress.
        const s = seen.get(u.id);
        if (u.state === 'move' && s && t - s.t >= rate) expect(Math.hypot(u.x - s.x, u.y - s.y)).toBeGreaterThan(0.1);
        if (!s || t - s.t >= rate) seen.set(u.id, { x: u.x, y: u.y, t });
      }
    }
  });

  it('ending early scores what was destroyed: stars, loot share and trophies', () => {
    const r = new Raid(1, plot, newBase(), 1, 9);
    for (let i = 0; i < 6; i++) r.deploy('r_bat', plot.x + 0.5, plot.y + 0.5 + i * 0.4);
    while (!r.vaultDown() && !r.done) r.step();
    r.end();
    expect(r.endReason).toBe('ended');
    expect(r.stars).toBe(r.currentStars());
    expect(raidStars(0.49, false)).toBe(0);
    expect(raidStars(0.5, false)).toBe(1);
    expect(raidStars(0.5, true)).toBe(2);
    expect(raidStars(1, true)).toBe(3);
    const f = CONFIG.pvp.loot.fromVault;
    expect(raidLoot(300, 0, false)).toBe(0);
    expect(raidLoot(300, 1 / 3, true)).toBe(Math.round(300 * ((1 - f) / 3 + f)));
    expect(raidLoot(300, 1, true)).toBe(300);
    expect(raidTrophies(30, 3)).toBe(30);
    expect(raidTrophies(30, 1)).toBe(10);
    expect(raidTrophies(30, 0)).toBe(-15);
  });

  it('loot and trophies are capped and shrink against much weaker players', () => {
    expect(lootable(50, 1)).toBe(0); // protected floor
    expect(lootable(1000, 1)).toBe(Math.round(1000 * CONFIG.pvp.loot.pct));
    expect(lootable(1_000_000, 2)).toBe(CONFIG.pvp.loot.capBase + 2 * CONFIG.pvp.loot.capPerHq);
    const M = CONFIG.pvp.match;
    // Even fight: 1. Much weaker (trophies and level): little. Stronger: more.
    expect(matchFactor(100, 100, 3, 3)).toBe(1);
    expect(matchFactor(1000, 100, 3, 3)).toBe(M.min);
    expect(matchFactor(100, 100 + M.span, 3, 3)).toBe(M.max);
    expect(matchFactor(100, 100, 5, 1)).toBeCloseTo(Math.max(M.levelMin, 1 - 4 * M.perLevel));
    expect(matchFactor(100, 100, 1, 3)).toBeCloseTo(1 + 2 * M.perLevel);
    expect(matchFactor(1000, 0, 6, 1)).toBeLessThan(0.15);
    expect(trophyStake(100, 100, 2, 2)).toBe(CONFIG.pvp.trophies.base);
    expect(trophyStake(1000, 0, 5, 1)).toBe(CONFIG.pvp.trophies.min);
    expect(trophyStake(0, 1000, 1, 4)).toBe(CONFIG.pvp.trophies.max);
    expect(starBonus(3, 2)).toBe(3 * CONFIG.pvp.loot.starBonus[1]!);
    expect(starBonus(2, 2, 0.25)).toBe(Math.round(2 * CONFIG.pvp.loot.starBonus[1]! * 0.25));
    // The vault always has room for the next Main Tower upgrade.
    for (let hq = 1; hq < CONFIG.hq.maxLevel; hq++) expect(vaultCapacity(hq)).toBeGreaterThanOrEqual(CONFIG.hq.upgradeCost[hq - 1]!);
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
