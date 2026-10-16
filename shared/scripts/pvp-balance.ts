// PvP sanity check: win rate and cost for some raid compositions vs some bases.
// Usage: npx tsx shared/scripts/pvp-balance.ts
import { CONFIG, Raid, raiderCost, getWorld, newBase, type BaseState, type RaiderKind } from '../src/index.ts';

const plot = getWorld().plots[27]!;
const b = (hq: number, walls: number, posts: [string, number][]): BaseState => ({
  hq, walls, posts: Array.from({ length: 8 }, (_, i) => (posts[i] ? { type: posts[i]![0] as never, level: posts[i]![1] } : null)),
});
function raid(label: string, def: BaseState, atkHq: number, army: [RaiderKind, number][], n = 60) {
  let wins = 0, destr = 0, cost = 0, ticks = 0, stars = 0, vaults = 0;
  const why = new Map<string, number>();
  for (let s = 1; s <= n; s++) {
    const r = new Raid(s, plot, def, atkHq, s * 977);
    // drop the army on the apron near one corner, a few at a time
    let t = 0;
    for (const [kind, count] of army) for (let i = 0; i < count; i++) {
      r.deploy(kind, plot.x + 0.5 + (i % 3) * 0.6, plot.y + 0.5 + Math.floor(i / 3) * 0.4);
      cost += raiderCost(kind, atkHq);
      for (let k = 0; k < 4; k++) r.step(true);
      t++;
    }
    // Army spent: the raid plays out until the raiders are dead or everything is down (no timer).
    while (!r.done) r.step(false);
    if (r.won) wins++;
    stars += r.stars;
    if (r.vaultDown()) vaults++;
    why.set(r.endReason!, (why.get(r.endReason!) ?? 0) + 1);
    destr += r.combat.destruction();
    ticks += r.combat.tick;
  }
  const reasons = [...why].map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`${label.padEnd(46)} win ${String(Math.round((100 * wins) / n)).padStart(3)}%  stars ${(stars / n).toFixed(1)}  destruction ${(100 * destr / n).toFixed(0).padStart(3)}%  vault ${String(Math.round((100 * vaults) / n)).padStart(3)}%  cost ${String(Math.round(cost / n)).padStart(3)}  lasts ${(ticks / n / CONFIG.tickRate).toFixed(0).padStart(3)}s  (${reasons})`);
}
raid('HQ1 attacker: 6 bats vs starter base', newBase(), 1, [['r_bat', 6]]);
raid('HQ1 attacker: 10 bats vs starter base', newBase(), 1, [['r_bat', 10]]);
raid('HQ2: 6 bats + 4 pistols vs HQ2 base', b(2, 2, [['pistol', 2], ['pistol', 2], ['gun', 1]]), 2, [['r_bat', 6], ['r_pistol', 4]]);
raid('HQ3: 3 helmets + 6 bats + 4 pistols vs HQ3 base', b(3, 3, [['pistol', 3], ['gun', 3], ['shotgun', 2], ['pistol', 2]]), 3, [['r_helmet', 3], ['r_bat', 6], ['r_pistol', 4]]);
raid('HQ3: 6 bats vs HQ3 base (underpowered)', b(3, 3, [['pistol', 3], ['gun', 3], ['shotgun', 2], ['pistol', 2]]), 3, [['r_bat', 6]]);
raid('HQ5: 4 helmets + 6 shotguns + 6 bats vs HQ5', b(5, 5, [['gun', 5], ['gun', 5], ['shotgun', 5], ['pistol', 5], ['shotgun', 4], ['gun', 4]]), 5, [['r_helmet', 4], ['r_shotgun', 6], ['r_bat', 6]]);
// Around the tipping point: how big an army it takes (the threshold should barely move when the pace changes).
const hq2 = b(2, 2, [['pistol', 2], ['pistol', 2], ['gun', 1]]);
for (const n of [6, 8, 10, 12]) raid(`HQ2: ${n} bats + ${Math.round(n * 0.6)} pistols vs HQ2 base`, hq2, 2, [['r_bat', n], ['r_pistol', Math.round(n * 0.6)]]);
const hq3 = b(3, 3, [['pistol', 3], ['gun', 3], ['shotgun', 2], ['pistol', 2]]);
for (const n of [1, 2, 3]) raid(`HQ3: ${n} helmets + 6 bats + 4 pistols vs HQ3`, hq3, 3, [['r_helmet', n], ['r_bat', 6], ['r_pistol', 4]]);
for (const n of [3, 4, 5]) raid(`HQ1: ${n} bats vs starter base`, newBase(), 1, [['r_bat', n]]);
