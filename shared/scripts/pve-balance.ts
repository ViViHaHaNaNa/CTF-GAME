// Quick PvE balance check: breach rate, coins and duration per wave for a few base builds.
// Usage: npx tsx shared/scripts/pve-balance.ts
import { CONFIG, ZombieWave, getWorld, newBase, type BaseState } from '../src/index.ts';

// Average over a few plots so every graveyard direction is represented.
const PLOTS = [0, 1, 8, 9, 27, 36].map((i) => getWorld().plots[i]!);

function run(label: string, base: BaseState, n = 200) {
  let breaches = 0, coins = 0, ticks = 0;
  for (let s = 1; s <= n; s++) {
    const w = new ZombieWave(base, s * 7919, PLOTS[s % PLOTS.length]!);
    w.runToEnd();
    if (w.breached) breaches++;
    coins += w.coins;
    ticks += w.combat.tick;
  }
  const secs = ticks / n / CONFIG.tickRate;
  const perMin = (coins / n) * 60 / (secs + CONFIG.waves.calm);
  console.log(`${label.padEnd(34)} breach ${String(Math.round((100 * breaches) / n)).padStart(3)}%  coins/wave ${(coins / n).toFixed(1).padStart(6)}  wave ${secs.toFixed(1).padStart(5)}s  coins/min ${perMin.toFixed(0).padStart(4)}`);
}

const b = (hq: number, walls: number, posts: [string, number][]): BaseState => ({
  hq, walls, posts: Array.from({ length: 8 }, (_, i) => (posts[i] ? { type: posts[i]![0] as never, level: posts[i]![1] } : null)),
});
run('start (HQ1, 1 pistol)', newBase());
run('HQ1, 2 pistols', b(1, 1, [['pistol', 1], ['pistol', 1]]));
run('HQ1, 2 pistols L1 + walls ... ', b(1, 1, [['pistol', 1], ['pistol', 1]]));
run('HQ2, 2 pistol L2 + gun, walls 2', b(2, 2, [['pistol', 2], ['pistol', 2], ['gun', 1]]));
run('HQ3, mixed L3, walls 3', b(3, 3, [['pistol', 3], ['gun', 3], ['shotgun', 2], ['pistol', 2]]));
run('HQ3, only 2 pistol L1 (neglected)', b(3, 1, [['pistol', 1], ['pistol', 1]]));
run('HQ5, mixed L5, walls 5', b(5, 5, [['gun', 5], ['gun', 5], ['shotgun', 5], ['pistol', 5], ['shotgun', 4], ['gun', 4]]));
run('HQ8, all L8, walls 8', b(8, 8, [['gun', 8], ['gun', 8], ['shotgun', 8], ['shotgun', 8], ['gun', 8], ['pistol', 8], ['shotgun', 8], ['gun', 8]]));
