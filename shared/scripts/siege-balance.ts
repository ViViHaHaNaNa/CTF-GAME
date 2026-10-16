// Siege balance: per Main Tower level, how surges go (held share, length, zombies, coins) and what
// grinding pays per minute when waiting out each countdown vs calling every surge early; plus a new
// player's walkthrough and guided first minutes; plus coarse (offline) vs live.
// Usage: npx tsx shared/scripts/siege-balance.ts
import { CONFIG, Siege, applyAction, commanderSpot, getWorld, mulberry32, newBase, newDirector, quote, type BaseAction, type BaseState, type DirectorState } from '../src/index.ts';

const world = getWorld();
const PLOTS = [0, 9, 18, 27, 36, 45, 54, 63].map((i) => world.plots[i]!);
const pct = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 0}%`.padStart(4);
const b = (hq: number, walls: number, posts: [string, number][], cmd = 0): BaseState => ({
  hq, walls, cmd, posts: Array.from({ length: 8 }, (_, i) => (posts[i] ? { type: posts[i]![0] as never, level: posts[i]![1] } : null)),
});

/** A sensible base at each level (what a player who keeps upgrading would have). */
const BUILDS: BaseState[] = [
  b(1, 1, [['pistol', 1], ['pistol', 1]]),
  b(2, 2, [['pistol', 2], ['pistol', 2], ['gun', 1]], 1),
  b(3, 3, [['pistol', 3], ['gun', 3], ['shotgun', 2], ['pistol', 2]], 2),
  b(4, 4, [['gun', 4], ['gun', 3], ['shotgun', 3], ['pistol', 4], ['gun', 3]], 2),
  b(5, 5, [['gun', 5], ['gun', 5], ['shotgun', 5], ['pistol', 5], ['shotgun', 4], ['gun', 4]], 2),
  b(6, 6, [['gun', 6], ['gun', 6], ['shotgun', 6], ['pistol', 6], ['shotgun', 5], ['gun', 5], ['gun', 5]], 2),
  b(7, 7, [['gun', 7], ['gun', 7], ['shotgun', 7], ['gun', 6], ['shotgun', 6], ['gun', 6], ['gun', 6], ['shotgun', 6]], 2),
  b(8, 8, [['gun', 8], ['gun', 8], ['shotgun', 8], ['gun', 8], ['shotgun', 7], ['gun', 7], ['gun', 7], ['shotgun', 7]], 2),
];

/** Taps at the zombie nearest the Main Tower at `rate` per second, with aim error. */
function tapper(s: Siege, rate: number, aim: number, rng: () => number) {
  const every = Math.max(1, Math.round(s.combat.rate / rate));
  return () => {
    if (s.combat.tick % every || !s.combat.liveUnits) return 0;
    const [hx, hy] = commanderSpot(s.plot);
    let best: { x: number; y: number } | undefined;
    let bd = Infinity;
    for (const u of s.combat.units) {
      if (u.state === 'dead' || u.state === 'rise') continue;
      const d = Math.hypot(u.x - hx, u.y - hy);
      if (d < bd) (bd = d), (best = u);
    }
    if (!best) return 0;
    const r = s.tap(best.x + (rng() - 0.5) * 2 * aim, best.y + (rng() - 0.5) * 2 * aim);
    return r.ok ? r.coins : 0;
  };
}

/** Run a level's base for `surges` surges; `early`: call each surge as soon as the countdown allows. */
function level(base: BaseState, early: boolean, taps: number, surges = 14, runs = 4) {
  let held = 0, lost = 0, coins = 0, secs = 0, kills = 0, len = 0, peak = 0, zombies = 0, bosses = 0, sides = 0;
  for (let i = 1; i <= runs; i++) {
    const d: DirectorState = { ...newDirector(), played: 20 * 60, surges: 50, pressure: SETTLED };
    const s = new Siege(base, PLOTS[i % PLOTS.length]!, i * 7919, d, { firstDelay: 1 });
    s.counting = false;
    const rng = mulberry32(i);
    const tap = taps ? tapper(s, taps, 0.5, rng) : () => 0;
    let start = 0;
    let done = 0;
    while (done < surges) {
      coins += s.step() + tap();
      if (early && s.phase === 'breather') coins += s.callEarly();
      peak = Math.max(peak, s.combat.liveUnits);
      for (const e of s.events) {
        if (e.type === 'surge') (start = s.combat.tick), (zombies += e.size), (bosses += e.boss ? 1 : 0), (sides += e.sides.filter((n) => n > 0).length);
        if (e.type === 'held' || e.type === 'breach') {
          if (e.type === 'held') held++;
          else lost++;
          len += (s.combat.tick - start) / s.combat.rate;
          done++;
        }
      }
      s.events.length = 0;
    }
    kills += s.kills;
    secs += s.combat.tick / s.combat.rate;
  }
  const n = held + lost;
  return { held: held / n, len: len / n, perSurge: coins / n, perMin: (coins / secs) * 60, zombies: zombies / n, bosses: bosses / n, sides: sides / n, peak };
}

/** Pressure to start the per-level runs from (the director would have drifted there over a long session). */
const SETTLED = Number(process.env.PRESSURE ?? 1);
console.log(`-- per level: a typical base for that level, a player tapping 2/s, starting pressure ${SETTLED} --`);
console.log('HQ  gap  sides  zombies  boss   surge   held  coins/surge  coins/min (waiting)  coins/min (calling early)  peak');
BUILDS.forEach((base, i) => {
  const wait = level(base, false, 2);
  const early = level(base, true, 2);
  console.log(
    `${String(i + 1).padStart(2)}  ${String(CONFIG.siege.gap[i]).padStart(3)}s  ${wait.sides.toFixed(1).padStart(4)}  ${wait.zombies.toFixed(0).padStart(6)}  ${wait.bosses.toFixed(2).padStart(5)}  ${wait.len.toFixed(0).padStart(4)}s  ${pct(wait.held * 100, 100)}  ${wait.perSurge.toFixed(0).padStart(10)}  ${wait.perMin.toFixed(0).padStart(19)}  ${early.perMin.toFixed(0).padStart(25)}  ${String(wait.peak).padStart(4)}`,
  );
});
if (process.env.QUICK) process.exit(0);
console.log('\n-- same, no tapping (offline / idle) --');
BUILDS.forEach((base, i) => {
  const r = level(base, false, 0);
  console.log(`HQ${i + 1}: held ${pct(r.held * 100, 100)}  surge ${r.len.toFixed(0)}s  ${r.perMin.toFixed(0)} coins/min`);
});

/** Cheapest thing the player can afford right now. */
function cheapest(base: BaseState): BaseAction | null {
  const opts: BaseAction[] = [{ kind: 'hq' }, { kind: 'walls' }, { kind: 'commander' }];
  base.posts.forEach((p, slot) => opts.push(p ? { kind: 'post', slot } : { kind: 'build', slot, type: 'pistol' }));
  let best: BaseAction | null = null;
  let cost = Infinity;
  for (const a of opts) {
    const q = quote(base, a);
    if (q.ok && q.cost < cost) (best = a), (cost = q.cost);
  }
  return best;
}

console.log('\n-- a brand-new player (walkthrough first), 15 minutes, taps 2/s, buys the cheapest thing, calls early or not --');
for (const early of [false, true]) {
  let held = 0, surges = 0, tutorialHeld = 0, hq = 0, firstSides = 0, guidedSides = 0, guidedN = 0;
  const runs = 16;
  for (let i = 1; i <= runs; i++) {
    let base = newBase();
    let coins = CONFIG.start.coins;
    const s = new Siege(base, PLOTS[i % PLOTS.length]!, i * 104729, newDirector());
    const tap = tapper(s, 2, 0.6, mulberry32(i));
    for (let t = 0; t < 15 * 60 * s.combat.rate; t++) {
      coins += s.step() + tap();
      if (early && s.phase === 'breather') coins += s.callEarly();
      for (const e of s.events) {
        if (e.type === 'surge' && e.tutorial) firstSides += e.sides.filter((n) => n > 0).length;
        else if (e.type === 'surge' && base.hq < CONFIG.siege.guidedBelow) (guidedSides += e.sides.filter((n) => n > 0).length), guidedN++;
        if (e.type === 'held') (held++, surges++, e.n === 1 && tutorialHeld++);
        if (e.type === 'breach') surges++;
      }
      s.events.length = 0;
      if (t % s.combat.rate === 0) {
        const a = cheapest(base);
        if (a && quote(base, a).cost <= coins) {
          coins -= quote(base, a).cost;
          base = applyAction(base, a);
          s.setBase(base);
        }
      }
    }
    hq += base.hq;
  }
  console.log(`${early ? 'calls early' : 'waits     '}: walkthrough held ${tutorialHeld}/${runs} (from ${(firstSides / runs).toFixed(1)} side), held ${pct(held, surges)} of ${(surges / runs).toFixed(1)} surges, guided surges from ${(guidedSides / Math.max(1, guidedN)).toFixed(1)} sides, reaches HQ ${(hq / runs).toFixed(1)}`);
}

console.log('\n-- coarse headless (offline) vs live, no taps --');
for (const i of [1, 3, 5]) {
  const live = level(BUILDS[i]!, false, 0, 8, 6);
  let held = 0, n = 0, coins = 0;
  for (let k = 1; k <= 6; k++) {
    const s = new Siege(BUILDS[i]!, PLOTS[k % PLOTS.length]!, k * 7919, { ...newDirector(), played: 1200, surges: 50 }, { coarse: true, ramp: false, firstDelay: 0 });
    for (let j = 0; j < 8; j++) {
      s.runSurge();
      for (const e of s.events) (e.type === 'held' && held++), (e.type !== 'surge' && n++);
      s.events.length = 0;
    }
    coins += s.coins;
  }
  console.log(`HQ${i + 1}: live held ${pct(live.held * 100, 100)} ${live.perSurge.toFixed(0)}/surge | coarse held ${pct(held, n)} ${(coins / n).toFixed(0)}/surge`);
}
