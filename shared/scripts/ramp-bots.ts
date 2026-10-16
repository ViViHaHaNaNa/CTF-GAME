// The difficulty ramp, checked with bot players (all tapping zombies 2/s like an engaged player):
//  - "never upgrades": keeps the starter base forever. Must start losing posts/walls around surge 6-8
//    and get breached around surge 10-12.
//  - "upgrades sensibly": builds the basic base, then keeps posts and walls at the Main Tower's cap and
//    levels the Main Tower when they are; must hold ~70-80% of surges through Main Tower 8.
// Usage: npx tsx shared/scripts/ramp-bots.ts
import {
  CONFIG,
  COMMANDER_WEAPONS,
  Siege,
  applyAction,
  basicBaseDone,
  breachLoss,
  commanderSpot,
  defenceRating,
  getWorld,
  mulberry32,
  newBase,
  newDirector,
  quote,
  slotsUnlocked,
  surgePower,
  vaultCapacity,
  type BaseAction,
  type BaseState,
} from '../src/index.ts';

const world = getWorld();
const PLOTS = [0, 9, 18, 27, 36, 45, 54, 63].map((i) => world.plots[i]!);
const TAPS = Number(process.env.TAPS ?? 2);

function tapper(s: Siege, rate: number, rng: () => number) {
  if (!rate) return () => 0;
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
    const r = s.tap(best.x + (rng() - 0.5) * 1.2, best.y + (rng() - 0.5) * 1.2);
    return r.ok ? r.coins : 0;
  };
}

/** What a sensible player buys next: the basic base, then posts and walls up to the Main Tower's cap, then the Main Tower. */
function nextBuy(base: BaseState): BaseAction | null {
  const unlocked = slotsUnlocked(base.hq);
  for (let slot = 0; slot < unlocked; slot++) {
    if (base.posts[slot]) continue;
    const type = base.hq >= CONFIG.hq.postUnlock.shotgun && slot % 3 === 2 ? 'shotgun' : base.hq >= CONFIG.hq.postUnlock.gun ? 'gun' : 'pistol';
    return { kind: 'build', slot, type };
  }
  if (!basicBaseDone(base)) {
    if (base.hq < 2) return { kind: 'hq' };
    if (!base.posts.some((p) => p && p.level >= 2)) return { kind: 'post', slot: 0 };
    if (base.walls < 2) return { kind: 'walls' };
  }
  let low = -1;
  base.posts.forEach((p, i) => {
    if (p && p.level < base.hq && (low < 0 || p.level < base.posts[low]!.level)) low = i;
  });
  if (low >= 0) return { kind: 'post', slot: low };
  if (base.walls < base.hq) return { kind: 'walls' };
  if (quote(base, { kind: 'commander' }).ok) return { kind: 'commander' };
  if (base.hq < CONFIG.hq.maxLevel) return { kind: 'hq' };
  return null;
}

let BOUGHT = 0;

interface SurgeLog { n: number; hq: number; held: boolean; postsLost: number; wallsLost: number; defence: number; threat: number; coins: number; spent: number }

function play(seed: number, upgrades: boolean, maxSurges: number, stopAfterHq8 = 12): SurgeLog[] {
  let base = newBase();
  let coins = CONFIG.start.coins;
  const d = newDirector();
  const s = new Siege(base, PLOTS[seed % PLOTS.length]!, seed * 7919, d);
  const tap = tapper(s, TAPS, mulberry32(seed));
  const log: SurgeLog[] = [];
  let lostPosts = new Set<number>();
  let lostWalls = new Set<number>();
  let spent = 0;
  let atHq8 = 0;
  const vault = () => vaultCapacity(base.hq);
  while (log.length < maxSurges && atHq8 < stopAfterHq8) {
    coins = Math.min(vault(), coins + s.step() + tap());
    for (const b of s.combat.buildings.values()) {
      if (b.alive) continue;
      if (b.kind === 'post') lostPosts.add(b.id);
      if (b.kind === 'wall') lostWalls.add(b.id);
    }
    for (const e of s.events) {
      if (e.type === 'surge') {
        lostPosts = new Set();
        lostWalls = new Set();
      }
      if (e.type === 'held' || e.type === 'breach') {
        if (e.type === 'breach') coins -= breachLoss(coins, base.hq);
        const t = s.threat();
        log.push({ n: e.n, hq: base.hq, held: e.type === 'held', postsLost: lostPosts.size, wallsLost: lostWalls.size, defence: t.defence, threat: t.next, coins, spent });
        spent = 0;
        if (base.hq === 8) atHq8++;
      }
    }
    s.events.length = 0;
    // Between surges, buy what it can (a sensible player saves for the next thing on the list).
    if (upgrades && s.phase !== 'surge' && s.combat.tick % s.combat.rate === 0) {
      for (let k = 0; k < 4; k++) {
        const a = nextBuy(base);
        if (!a) break;
        const q = quote(base, a);
        if (!q.ok || q.cost > coins) break;
        coins -= q.cost;
        spent += q.cost;
        BOUGHT++;
        base = applyAction(base, a);
        s.setBase(base);
      }
    }
  }
  return log;
}

// Tuning knobs from the environment (the config's values otherwise).
const env = (k: string) => (process.env[k] === undefined ? undefined : Number(process.env[k]));
const R = CONFIG.siege.ramp as { start: number; growth: number; growthLate: number; taperOver: number; max: number; countCap: number };
R.start = env('START') ?? R.start;
R.growth = env('G') ?? R.growth;
R.growthLate = env('GL') ?? R.growthLate;
R.max = env('MAX') ?? R.max;
R.countCap = env('CAP') ?? R.countCap;
(CONFIG.siege as { coinsPerPower: number }).coinsPerPower = env('K') ?? CONFIG.siege.coinsPerPower;
(CONFIG.siege as { holdPerPower: number }).holdPerPower = env('H') ?? CONFIG.siege.holdPerPower;
(CONFIG.posts as { upgradeGrowth: number }).upgradeGrowth = env('PG') ?? CONFIG.posts.upgradeGrowth;
(CONFIG.walls as { upgradeGrowth: number }).upgradeGrowth = env('WG') ?? CONFIG.walls.upgradeGrowth;
const ONLY = process.env.ONLY;

const pct = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 0}%`;
const SEEDS = Number(process.env.SEEDS ?? 6);

console.log(`Ramp: x${CONFIG.siege.ramp.growth} per surge tapering to x${CONFIG.siege.ramp.growthLate} over ${CONFIG.siege.ramp.taperOver}, start ${CONFIG.siege.ramp.start}, count cap x${CONFIG.siege.ramp.countCap}, max x${CONFIG.siege.ramp.max}; taps ${TAPS}/s\n`);

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
if (ONLY !== 'up') {
console.log('-- never upgrades --');
const firsts: { post: number; wall: number; breach: number }[] = [];
for (let seed = 1; seed <= SEEDS; seed++) {
  const log = play(seed, false, 20);
  const first = (f: (l: SurgeLog) => boolean) => log.find(f)?.n ?? -1;
  firsts.push({ post: first((l) => l.postsLost > 0), wall: first((l) => l.wallsLost > 0), breach: first((l) => !l.held) });
  if (seed === 1) console.log('  surge by surge (seed 1):', log.map((l) => `${l.n}:${l.held ? 'held' : 'BREACH'}${l.postsLost ? ` -${l.postsLost}p` : ''}${l.wallsLost ? ` -${l.wallsLost}w` : ''} ${l.defence}/${l.threat}`).join('  '));
}
console.log(`  first post lost: surge ${med(firsts.map((f) => f.post))}, first wall lost: surge ${med(firsts.map((f) => f.wall))}, first breach: surge ${med(firsts.map((f) => f.breach))} (medians of ${SEEDS}; each: ${firsts.map((f) => f.breach).join(' ')})`);
}
if (ONLY !== 'never') {
console.log('\n-- upgrades sensibly --');
const byHq = new Map<number, { held: number; n: number }>();
const reach: number[][] = [];
const buys: number[] = [];
let all = 0, allHeld = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const log = play(seed, true, 400);
  buys.push(BOUGHT / log.length);
  BOUGHT = 0;
  const r: number[] = [];
  for (const l of log) {
    const b = byHq.get(l.hq) ?? { held: 0, n: 0 };
    b.n++;
    if (l.held) b.held++;
    byHq.set(l.hq, b);
    all++;
    if (l.held) allHeld++;
    if (r[l.hq] === undefined) r[l.hq] = l.n;
  }
  reach.push(r);
  if (seed === 1) {
    console.log('  seed 1, every 5th surge:');
    for (const l of log.filter((x) => x.n % 5 === 0)) console.log(`    surge ${String(l.n).padStart(3)}  HQ${l.hq}  ${l.held ? 'held  ' : 'BREACH'}  defence ${String(l.defence).padStart(4)} / threat ${String(l.threat).padStart(4)}  vault ${l.coins}`);
  }
}
for (const [hq, b] of [...byHq].sort((a, b) => a[0] - b[0])) console.log(`  HQ${hq}: held ${pct(b.held, b.n)} of ${b.n} surges`);
console.log(`  upgrades bought per surge (median run): ${(med(buys) ).toFixed(2)}`);
console.log(`  overall held ${pct(allHeld, all)}; surge reaching each Main Tower level (median): ${[2, 3, 4, 5, 6, 7, 8].map((h) => `HQ${h}@${med(reach.map((r) => r[h] ?? 999))}`).join(' ')}`);
}
void COMMANDER_WEAPONS;
void surgePower;
