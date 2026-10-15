// PvP sanity check: win rate and cost for some raid compositions vs some bases.
// Usage: npx tsx shared/scripts/pvp-balance.ts
import { CONFIG, Raid, getWorld, newBase, type BaseState, type RaiderKind } from '../src/index.ts';

const plot = getWorld().plots[27]!;
const b = (hq: number, walls: number, posts: [string, number][]): BaseState => ({
  hq, walls, posts: Array.from({ length: 8 }, (_, i) => (posts[i] ? { type: posts[i]![0] as never, level: posts[i]![1] } : null)),
});
function raid(label: string, def: BaseState, atkHq: number, army: [RaiderKind, number][], n = 60) {
  let wins = 0, destr = 0, cost = 0;
  for (let s = 1; s <= n; s++) {
    const r = new Raid(s, plot, def, atkHq, s * 977);
    // drop the army on the apron near one corner, a few at a time
    let t = 0;
    for (const [kind, count] of army) for (let i = 0; i < count; i++) {
      r.deploy(kind, plot.x + 0.5 + (i % 3) * 0.6, plot.y + 0.5 + Math.floor(i / 3) * 0.4);
      cost += CONFIG.pvp.raiders[kind].cost;
      for (let k = 0; k < 4; k++) r.step();
      t++;
    }
    while (!r.done) r.step();
    if (r.won) wins++;
    destr += r.combat.destruction();
  }
  console.log(`${label.padEnd(44)} win ${String(Math.round((100 * wins) / n)).padStart(3)}%  destruction ${(100 * destr / n).toFixed(0).padStart(3)}%  cost ${Math.round(cost / n)}`);
}
raid('HQ1 attacker: 6 bats vs starter base', newBase(), 1, [['r_bat', 6]]);
raid('HQ1 attacker: 10 bats vs starter base', newBase(), 1, [['r_bat', 10]]);
raid('HQ2: 6 bats + 4 pistols vs HQ2 base', b(2, 2, [['pistol', 2], ['pistol', 2], ['gun', 1]]), 2, [['r_bat', 6], ['r_pistol', 4]]);
raid('HQ3: 3 helmets + 6 bats + 4 pistols vs HQ3 base', b(3, 3, [['pistol', 3], ['gun', 3], ['shotgun', 2], ['pistol', 2]]), 3, [['r_helmet', 3], ['r_bat', 6], ['r_pistol', 4]]);
raid('HQ3: 6 bats vs HQ3 base (underpowered)', b(3, 3, [['pistol', 3], ['gun', 3], ['shotgun', 2], ['pistol', 2]]), 3, [['r_bat', 6]]);
raid('HQ5: 4 helmets + 6 shotguns + 6 bats vs HQ5', b(5, 5, [['gun', 5], ['gun', 5], ['shotgun', 5], ['pistol', 5], ['shotgun', 4], ['gun', 4]]), 5, [['r_helmet', 4], ['r_shotgun', 6], ['r_bat', 6]]);
