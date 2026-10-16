// Siege balance check: how a new player's first minutes go, steady-state income per base build, and
// whether the coarse headless mode agrees with the live one.
// Usage: npx tsx shared/scripts/siege-balance.ts
import { CONFIG, Siege, applyAction, getWorld, newBase, newDirector, quote, type BaseAction, type BaseState, type DirectorState } from '../src/index.ts';

const world = getWorld();
const PLOTS = [0, 9, 18, 27, 36, 45, 54, 63].map((i) => world.plots[i]!);
const pct = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 0}%`.padStart(4);

/** Cheapest thing the player can afford right now (what an eager new player taps). */
function cheapest(base: BaseState): BaseAction | null {
  const opts: BaseAction[] = [{ kind: 'hq' }, { kind: 'walls' }];
  base.posts.forEach((p, slot) => opts.push(p ? { kind: 'post', slot } : { kind: 'build', slot, type: 'pistol' }));
  let best: BaseAction | null = null;
  let cost = Infinity;
  for (const a of opts) {
    const q = quote(base, a);
    if (q.ok && q.cost < cost) (best = a), (cost = q.cost);
  }
  return best;
}

interface Run { held: number; surges: number; coins: number; firstBuy: number; peak: number; sizes: number[]; pressure: number; hq: number }

/** A fresh player for `secs`: reacts after `react` s, then buys the cheapest thing whenever they can (`buys` false = never). */
function newPlayer(seed: number, secs: number, buys: boolean, react = 8): Run {
  let base = newBase();
  let coins = CONFIG.start.coins;
  const d = newDirector();
  const s = new Siege(base, PLOTS[seed % PLOTS.length]!, seed * 7919, d);
  let held = 0, surges = 0, firstBuy = -1, peak = 0;
  const sizes: number[] = [];
  const rate = s.combat.rate;
  for (let t = 0; t < secs * rate; t++) {
    coins += s.step();
    peak = Math.max(peak, s.combat.liveUnits);
    for (const e of s.events) {
      if (e.type === 'surge') sizes.push(e.size);
      if (e.type === 'held') (held++, surges++);
      if (e.type === 'breach') (surges++, (coins -= Math.max(0, Math.min(coins - CONFIG.siege.breach.protectedFloor, Math.round(coins * CONFIG.siege.breach.lossPct), CONFIG.siege.breach.maxLoss))));
    }
    s.events.length = 0;
    if (buys && t >= react * rate && t % rate === 0) {
      const a = cheapest(base);
      if (a && quote(base, a).cost <= coins) {
        coins -= quote(base, a).cost;
        base = applyAction(base, a);
        s.setBase(base);
        if (firstBuy < 0) firstBuy = t / rate;
      }
    }
  }
  return { held, surges, coins, firstBuy, peak, sizes, pressure: d.pressure, hq: base.hq };
}

function report(label: string, runs: Run[], secs: number) {
  const sum = (f: (r: Run) => number) => runs.reduce((a, r) => a + f(r), 0);
  const n = runs.length;
  console.log(
    `${label.padEnd(40)} held ${pct(sum((r) => r.held), sum((r) => r.surges))}  surges ${(sum((r) => r.surges) / n).toFixed(1).padStart(5)}` +
      `  first buy ${(sum((r) => r.firstBuy) / n).toFixed(0).padStart(3)}s  peak alive ${(sum((r) => r.peak) / n).toFixed(0).padStart(3)}  pressure ${(sum((r) => r.pressure) / n).toFixed(2)}  HQ ${(sum((r) => r.hq) / n).toFixed(1)}`,
  );
}

const b = (hq: number, walls: number, posts: [string, number][]): BaseState => ({
  hq, walls, posts: Array.from({ length: 8 }, (_, i) => (posts[i] ? { type: posts[i]![0] as never, level: posts[i]![1] } : null)),
});

/** A fixed base after a long session: held share, coins/min, surge size, with the director settled. */
function steady(label: string, base: BaseState, coarse = false, n = 24, mins = 6) {
  let held = 0, surges = 0, coins = 0, peak = 0, size = 0, sizes = 0, pressure = 0;
  for (let i = 1; i <= n; i++) {
    const d: DirectorState = { ...newDirector(), played: 20 * 60 };
    const s = new Siege(base, PLOTS[i % PLOTS.length]!, i * 104729, d, { coarse, ramp: !coarse });
    s.counting = false;
    // Let the director settle, then measure.
    s.runFor(120);
    s.events.length = 0;
    const c0 = s.coins;
    for (let t = 0; t < mins * 60 * s.combat.rate; t++) {
      s.step();
      peak = Math.max(peak, s.combat.liveUnits);
    }
    coins += s.coins - c0;
    for (const e of s.events) {
      if (e.type === 'held') (held++, surges++);
      if (e.type === 'breach') surges++;
      if (e.type === 'surge') (size += e.size), sizes++;
    }
    pressure += d.pressure;
  }
  console.log(`${label.padEnd(40)} held ${pct(held, surges)}  coins/min ${String(Math.round(coins / n / mins)).padStart(4)}  surge ${(size / sizes).toFixed(0).padStart(3)}  peak alive ${String(peak).padStart(3)}  pressure ${(pressure / n).toFixed(2)}`);
}

const N = 40;
console.log('-- a new player, first 5 minutes --');
report('buys the cheapest thing it can afford', Array.from({ length: N }, (_, i) => newPlayer(i + 1, 300, true)), 300);
report('never buys anything', Array.from({ length: N }, (_, i) => newPlayer(i + 1, 300, false)), 300);
const first = Array.from({ length: N }, (_, i) => newPlayer(i + 1, 60, false));
report('first minute (no buying)', first, 60);
console.log('surge sizes, first minute:', first[0]!.sizes.join(' '));
const eager = Array.from({ length: N }, (_, i) => newPlayer(i + 1, 300, true));
console.log('coins/min over 5 minutes (eager buyer, incl. spending):', (eager.reduce((a, r) => a + r.coins, 0) / N).toFixed(0), 'left at the end');

console.log('\n-- steady state (director settled, 20+ min played) --');
const builds: [string, BaseState][] = [
  ['start (HQ1, 1 pistol)', newBase()],
  ['HQ1, 2 pistols', b(1, 1, [['pistol', 1], ['pistol', 1]])],
  ['HQ2, 2 pistol L2 + gun, walls 2', b(2, 2, [['pistol', 2], ['pistol', 2], ['gun', 1]])],
  ['HQ3, mixed L3, walls 3', b(3, 3, [['pistol', 3], ['gun', 3], ['shotgun', 2], ['pistol', 2]])],
  ['HQ3, only 2 pistol L1 (neglected)', b(3, 1, [['pistol', 1], ['pistol', 1]])],
  ['HQ5, mixed L5, walls 5', b(5, 5, [['gun', 5], ['gun', 5], ['shotgun', 5], ['pistol', 5], ['shotgun', 4], ['gun', 4]])],
  ['HQ8, all L8, walls 8', b(8, 8, [['gun', 8], ['gun', 8], ['shotgun', 8], ['shotgun', 8], ['gun', 8], ['pistol', 8], ['shotgun', 8], ['gun', 8]])],
];
for (const [label, base] of builds) steady(label, base);

console.log('\n-- coarse headless vs live (same rules) --');
for (const [label, base] of [builds[1]!, builds[3]!, builds[4]!]) {
  steady(`live    ${label}`, base, false, 16);
  steady(`coarse  ${label}`, base, true, 16);
}

console.log('\n-- cost --');
{
  const base = builds[3]![1];
  const s = new Siege(base, PLOTS[3]!, 1, { ...newDirector(), played: 20 * 60, pressure: 1.5 });
  s.runFor(30);
  const t0 = performance.now();
  let ticks = 0;
  for (; ticks < 20 * 60 * 2; ticks++) s.step();
  const live = (performance.now() - t0) / ticks;
  const c = new Siege(base, PLOTS[3]!, 1, { ...newDirector(), played: 20 * 60, pressure: 1.5 }, { coarse: true, ramp: false });
  const t1 = performance.now();
  c.runFor(CONFIG.offline.every);
  console.log(`live tick ${(live * 1000).toFixed(0)} µs at ~${s.combat.liveUnits} zombies; one offline chunk (${CONFIG.offline.every}s coarse) ${(performance.now() - t1).toFixed(1)} ms`);
}
