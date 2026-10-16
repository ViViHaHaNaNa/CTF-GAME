// Sanity checks for the generated world. Usage: npx tsx shared/scripts/world-check.ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PLOT, PROP_FILES, RING, getWorld, hqCenter } from '../src/index.ts';

const w = getWorld();
const root = join(import.meta.dirname, '../../client/public/game-assets/postapocalypse');
const missing = PROP_FILES.filter((p) => !existsSync(join(root, p)));
console.log(`world ${w.w}x${w.h} tiles, ${w.plots.length} plots, ${w.graveyards.length} graveyards, ${w.props.length} props, ${PROP_FILES.length} prop files`);
console.log('missing prop files:', missing.length ? missing : 'none');

let overlaps = 0;
for (const a of w.plots) for (const b of w.plots) if (a.id < b.id && a.x < b.x + PLOT && b.x < a.x + PLOT && a.y < b.y + PLOT && b.y < a.y + PLOT) overlaps++;
console.log('plot overlaps:', overlaps);

const inPlot = (x: number, y: number, skip: number) => w.plots.some((p) => p.id !== skip && x >= p.x && x < p.x + PLOT && y >= p.y && y < p.y + PLOT);
/** Inside another base's walled compound (the open yard around it doesn't count). */
const inCompound = (x: number, y: number, skip: number) => w.plots.some((p) => p.id !== skip && x >= p.x + RING.x0 && x <= p.x + RING.x1 && y >= p.y + RING.y0 && y <= p.y + RING.y1);
let crossings = 0, minWalk = 1e9, maxWalk = 0, gravesInPlots = 0;
for (const g of w.graveyards) {
  if (g.serves.length < 3 || g.serves.length > 5) console.log('graveyard serves', g.serves.length);
  for (const gr of g.graves) if (inPlot(gr.x, gr.y, -1)) gravesInPlots++;
  for (const pid of g.serves) {
    const p = w.plots[pid]!;
    const [hx, hy] = hqCenter(p);
    for (const gr of g.graves) {
      const sx = gr.x + 0.5, sy = gr.y + 0.85;
      // walk distance to the nearest point of the wall ring
      const rx = Math.max(p.x + RING.x0, Math.min(sx, p.x + RING.x1 + 1));
      const ry = Math.max(p.y + RING.y0, Math.min(sy, p.y + RING.y1 + 1));
      const d = Math.hypot(sx - rx, sy - ry);
      minWalk = Math.min(minWalk, d); maxWalk = Math.max(maxWalk, d);
      for (let k = 0; k <= 200; k++) {
        const x = sx + ((hx - sx) * k) / 200, y = sy + ((hy - sy) * k) / 200;
        if (inCompound(Math.floor(x), Math.floor(y), p.id)) { crossings++; break; }
      }
    }
  }
}
console.log(`graves inside plots: ${gravesInPlots}; grave->wall walk ${minWalk.toFixed(1)}..${maxWalk.toFixed(1)} tiles; walks crossing another compound: ${crossings}`);
