// Grind vs raid economy, per Main Tower level: what grinding pays per surge and per minute, what a
// decent raid army costs (the cheapest that 2-stars a same-level base most of the time), what a raid
// pays (win or lose) and per minute. Targets: an army every 2-3 surges; raiding pays more per minute
// than grinding, with risk.
// Usage: npx tsx shared/scripts/economy-balance.ts
import { CONFIG, Raid, Siege, getWorld, lootable, mulberry32, newDirector, raidLoot, starBonus, vaultCapacity, inDeployZone, PLOT, type BaseState, type RaiderKind } from '../src/index.ts';

const world = getWorld();
const PLOTS = [0, 9, 18, 27, 36, 45, 54, 63].map((i) => world.plots[i]!);
const b = (hq: number, walls: number, posts: [string, number][], cmd = 0): BaseState => ({
  hq, walls, cmd, posts: Array.from({ length: 8 }, (_, i) => (posts[i] ? { type: posts[i]![0] as never, level: posts[i]![1] } : null)),
});

/** A typical base at each level, and the army mix a player at that level would bring (per "unit" of army). */
const LEVELS: { hq: number; base: BaseState; mix: [RaiderKind, number][] }[] = [
  { hq: 1, base: b(1, 1, [['pistol', 1], ['pistol', 1]]), mix: [['r_bat', 1]] },
  { hq: 2, base: b(2, 2, [['pistol', 2], ['pistol', 2], ['gun', 1]]), mix: [['r_bat', 5], ['r_pistol', 3]] },
  { hq: 3, base: b(3, 3, [['pistol', 3], ['gun', 3], ['shotgun', 2], ['pistol', 2]]), mix: [['r_bat', 4], ['r_pistol', 3], ['r_helmet', 1]] },
  { hq: 5, base: b(5, 5, [['gun', 5], ['gun', 5], ['shotgun', 5], ['pistol', 5], ['shotgun', 4], ['gun', 4]]), mix: [['r_bat', 3], ['r_pistol', 2], ['r_helmet', 1], ['r_shotgun', 2]] },
];
/** Seconds a raid costs beyond the fight: picking a target, deploying, watching the result. */
const OVERHEAD = 25;
/** How full a defender's vault is, typically. */
const VAULT_FILL = 0.6;

function grind(base: BaseState): { perMin: number; perSurge: number } {
  let coins = 0, surges = 0, secs = 0;
  for (let i = 1; i <= 6; i++) {
    const s = new Siege(base, PLOTS[i % PLOTS.length]!, i * 104729, { ...newDirector(), played: 20 * 60, surges: 50 }, { ramp: false, firstDelay: 0 });
    s.counting = false;
    // Six surges, each with the level's countdown before it (no calling early).
    for (let k = 0; k < 6; k++) s.runSurge();
    coins += s.coins;
    secs += s.combat.tick / s.combat.rate;
    surges += s.events.filter((e) => e.type === 'held' || e.type === 'breach').length;
  }
  return { perMin: (coins / secs) * 60, perSurge: coins / surges };
}

/** n "units" of the mix, dropped around the apron on every side (like a player spreading them out). */
function raid(level: (typeof LEVELS)[number], n: number, runs = 40) {
  const army: RaiderKind[] = [];
  for (const [k, c] of level.mix) for (let i = 0; i < c * n; i++) army.push(k);
  const cost = army.reduce((a, k) => a + CONFIG.pvp.raiders[k].cost, 0);
  let wins = 0, stars = 0, loot = 0, secs = 0;
  const defenderCoins = Math.round(vaultCapacity(level.hq) * VAULT_FILL);
  for (let s = 1; s <= runs; s++) {
    const plot = world.plots[27]!;
    const r = new Raid(s, plot, level.base, level.hq, s * 977);
    const rng = mulberry32(s);
    const spots: [number, number][] = [];
    for (let y = 0; y < PLOT; y++) for (let x = 0; x < PLOT; x++) if (inDeployZone(x, y)) spots.push([plot.x + x + 0.5, plot.y + y + 0.5]);
    // Two or three drop points, a few raiders at each, a moment apart.
    const drops = Array.from({ length: 2 + (s % 2) }, () => spots[Math.floor(rng() * spots.length)]!);
    army.forEach((k, i) => {
      const [x, y] = drops[i % drops.length]!;
      r.deploy(k, x + (rng() - 0.5) * 0.6, y + (rng() - 0.5) * 0.6);
      for (let t = 0; t < 3; t++) r.step(true);
    });
    while (!r.done) r.step(false);
    if (r.won) wins++;
    stars += r.stars;
    loot += raidLoot(lootable(defenderCoins, level.hq), r.destruction(), r.vaultDown()) + starBonus(r.stars, level.hq);
    secs += r.combat.tick / CONFIG.tickRate + OVERHEAD;
  }
  return { cost, win: wins / runs, stars: stars / runs, loot: loot / runs, secs: secs / runs };
}

console.log(`Defender vault ${Math.round(VAULT_FILL * 100)}% full; raid overhead ${OVERHEAD}s; even match (factor 1).`);
for (const L of LEVELS) {
  const g = grind(L.base);
  // The cheapest army size that wins (1+ star) 70% of the time.
  let pick = raid(L, 1);
  for (let n = 1; n <= 12 && pick.win < 0.7; n++) pick = raid(L, n);
  const net = pick.loot - pick.cost;
  console.log(
    `HQ${L.hq}: grind ${g.perMin.toFixed(0).padStart(4)}/min (${g.perSurge.toFixed(0)}/surge) | army ${String(pick.cost).padStart(4)} coins = ${(pick.cost / g.perSurge).toFixed(1)} surges | ` +
      `wins ${Math.round(pick.win * 100)}% ${pick.stars.toFixed(1)}★, loot ${pick.loot.toFixed(0)} | raid net ${net.toFixed(0)} in ${pick.secs.toFixed(0)}s = ${((net / pick.secs) * 60).toFixed(0)}/min (x${((net / pick.secs) * 60 / g.perMin).toFixed(2)} grind)`,
  );
}
