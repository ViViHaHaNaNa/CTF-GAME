import { mulberry32 } from './engine.ts';
import { HQ_RECT, PLOT } from './layout.ts';

// The shared open world. Generated from a fixed seed with shared code, so the server and every client
// build exactly the same map without shipping a layout file.
//
// 64 plots sit in a jittered 8x8 arrangement, grouped in 2x2 blocks. In the gap at the centre of each
// block is a graveyard that sends zombies to the 4 bases around it (a short diagonal walk that never
// crosses another compound). Dirt roads run between blocks; everything else is decorative scenery.

export const WORLD_SEED = 0x51e6e;
const CELL = 21;
const COLS = 8;
const MARGIN = 6;
export const WORLD_W = MARGIN * 2 + COLS * CELL;
export const WORLD_H = WORLD_W;

export interface WorldPlot {
  id: number;
  /** World tile of the plot's top-left corner. */
  x: number;
  y: number;
  /** Registration order: new players get the free plot with the lowest order (centre first). */
  order: number;
  graveyard: number;
}

export interface Grave {
  /** World tile (top-left of the 16px grave sprite). */
  x: number;
  y: number;
  kind: number;
}

export interface Graveyard {
  id: number;
  /** Mud patch, world tiles. */
  x: number;
  y: number;
  w: number;
  h: number;
  graves: Grave[];
  serves: number[];
}

export interface Prop {
  /** Index into PROP_FILES. */
  f: number;
  /** World pixel of the prop's bottom-centre. */
  x: number;
  y: number;
}

export interface World {
  w: number;
  h: number;
  plots: WorldPlot[];
  graveyards: Graveyard[];
  props: Prop[];
  /** Per tile: 0 ground, 1 road, 2 mud (graveyard). */
  ground: Uint8Array;
}

// ---- scenery catalogue ----------------------------------------------------------------------------
// Paths are relative to the art pack root. `t` = footprint in tiles (w, h) used to keep props apart.

const NAT = 'Objects/Nature';
const V = 'Objects/Vehicles';
interface PropDef { p: string; t: [number, number]; w: number }
const def = (p: string, t: [number, number], w: number): PropDef => ({ p, t, w });

export const SCENERY: PropDef[] = [
  ...['Bleak-Yellow', 'Orange', 'Red', 'Dark-Green'].flatMap((c) => [
    def(`${NAT}/${c}/Tree_1_Spruce_${c}.png`, [1, 1], 5),
    def(`${NAT}/${c}/Tree_3_Normal_${c}.png`, [1, 1], 6),
    def(`${NAT}/${c}/Tree_5_Big_${c}.png`, [2, 2], 4),
    def(`${NAT}/${c}/Tree_7_Birch_${c}.png`, [1, 1], 3),
    def(`${NAT}/${c}/Tree_9_Small-oak_${c}.png`, [1, 1], 4),
    def(`${NAT}/${c}/Bush_1_${c}.png`, [1, 1], 5),
    def(`${NAT}/${c}/Bush_2_${c}.png`, [1, 1], 4),
  ]),
  def(`${NAT}/Bleak-Yellow/Grass_1_Bleak-Yellow.png`, [1, 1], 10),
  def(`${NAT}/Bleak-Yellow/Grass_2_Bleak-Yellow.png`, [1, 1], 10),
  def(`${NAT}/Bleak-Yellow/Grass_3_Bleak-Yellow.png`, [1, 1], 8),
  def(`${NAT}/Bleak-Yellow/Rocks/Rock-grass_Bleak-Yellow.png`, [1, 1], 5),
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => def(`${NAT}/Flowers_Mashrooms_Other-nature-stuff/Rocks/Rock_${n}.png`, [1, 1], 2)),
  def(`${NAT}/Flowers_Mashrooms_Other-nature-stuff/Stump_1.png`, [1, 1], 3),
  def(`${NAT}/Flowers_Mashrooms_Other-nature-stuff/Tree_4_Dry_Green.png`, [1, 1], 3),
  def(`${V}/Rust/Car_1_Rust/Car_1_Rust_Red.png`, [2, 3], 1),
  def(`${V}/Rust/Car_2_Rust_Upsidedown/Car_2_Rust_Blue_Upsidedown.png`, [2, 3], 1),
  def(`${V}/Rust/Car_4_Rust/Car_4_Rust_Green.png`, [3, 2], 1),
  def(`${V}/Rust/Car_6_Rust_Scrap/Car_6_Rust_Orange_Scrap.png`, [3, 2], 1),
  def(`${V}/Overgrown/Car_4_Overgrown/Bleak-Yellow/Car_4_Overgrown_Bleak-Yellow_Yellow.png`, [3, 2], 1),
  def(`${V}/Overgrown/Car_3_Overgrown_Van/Bleak-Yellow/Car_3_Overgrown_Bleak-Yellow_Blue_Van.png`, [3, 2], 1),
  def(`${V}/Overgrown/Car_8_Overgrown_Bus/Bleak-Yellow/Car_8_Overgrown_Bleak-Yellow_Red_Bus.png`, [4, 2], 0.5),
  def(`${V}/Rust/Car_7_Rust_Truck/Car_7_Rust_Red_Truck_.png`, [4, 4], 0.4),
  def('Objects/Container/Container_4_Gray_Horizontal_Overgrown_Bleak-Yellow.png', [3, 2], 0.7),
  def('Objects/Container/Container_2_Gray_Vertical_Overgrown_Bleak-Yellow.png', [2, 3], 0.7),
  def('Objects/Buildings/Destroyed-wall_corner.png', [1, 1], 2),
  def('Objects/Buildings/Destroyed-wall_not-corner.png', [1, 1], 2),
  def('Objects/Buildings/Brick-wall_1_Lying.png', [1, 1], 2),
  def('Objects/Gray-brick_Debris.png', [1, 1], 2),
  def('Objects/2-Tires_Grass_Bleak-Yellow.png', [1, 1], 2),
  def('Objects/Tire_1.png', [1, 1], 1.5),
  def('Objects/Barrel_rust_red_1.png', [1, 1], 1.5),
  def('Objects/Barrel_rust_blue_2.png', [1, 1], 1),
  def('Objects/Trash-bag_1.png', [1, 1], 1),
  def('Objects/Traffic-cone.png', [1, 1], 1),
  def('Objects/Shopping-cart.png', [1, 1], 0.6),
  def('Objects/Stop-sign_Side_4_Overgrown_Bleak-Yellow.png', [1, 1], 0.6),
  def('Objects/Vending-machine_Red_Overgrown_Bleak-Yellow.png', [1, 1], 0.5),
];

/** Props used inside graveyards and ruined plots (indexes into PROP_FILES). */
export const SPECIAL = {
  deadTree: `${NAT}/Flowers_Mashrooms_Other-nature-stuff/Tree_4_Dry_Green.png`,
  stump: `${NAT}/Flowers_Mashrooms_Other-nature-stuff/Stump_1.png`,
  fenceH: 'Objects/Buildable/Wooden/Wooden-wall_Horizontal.png',
  fenceV: 'Objects/Buildable/Wooden/Wooden-wall_Vertical.png',
  debris: 'Objects/Gray-brick_Debris.png',
  bricks: 'Objects/Buildings/Brick-wall_2_Lying.png',
};

/** Every image the world references, in a stable order (Prop.f indexes into this). */
export const PROP_FILES: string[] = [...new Set([...SCENERY.map((d) => d.p), ...Object.values(SPECIAL)])];
const fileIndex = (p: string) => PROP_FILES.indexOf(p);

// ---- generation -----------------------------------------------------------------------------------

let cached: World | null = null;

export function getWorld(): World {
  return (cached ??= generateWorld(WORLD_SEED));
}

export function generateWorld(seed: number): World {
  const rnd = mulberry32(seed);
  const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
  const W = WORLD_W;
  const H = WORLD_H;
  const ground = new Uint8Array(W * H);
  /** Tiles nothing decorative may use. */
  const taken = new Uint8Array(W * H);
  const take = (x0: number, y0: number, w: number, h: number) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) taken[y * W + x] = 1;
  };
  const free = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x < 0 || y < 0 || x >= W || y >= H || taken[y * W + x]) return false;
    return true;
  };

  // Plots: jittered away from their block's centre so the graveyard always fits.
  const plots: WorldPlot[] = [];
  for (let r = 0; r < COLS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cx = MARGIN + c * CELL;
      const cy = MARGIN + r * CELL;
      const x = c % 2 === 0 ? cx + 3 + ri(-2, 0) : cx + 4 + ri(0, 2);
      const y = r % 2 === 0 ? cy + 3 + ri(-2, 0) : cy + 4 + ri(0, 2);
      const graveyard = Math.floor(r / 2) * (COLS / 2) + Math.floor(c / 2);
      plots.push({ id: plots.length, x, y, order: 0, graveyard });
      take(x, y, PLOT, PLOT);
    }
  }
  const mid = W / 2;
  [...plots]
    .sort((a, b) => Math.hypot(a.x + PLOT / 2 - mid, a.y + PLOT / 2 - mid) - Math.hypot(b.x + PLOT / 2 - mid, b.y + PLOT / 2 - mid) || a.id - b.id)
    .forEach((p, i) => (p.order = i));

  // Roads between 2x2 blocks (2 tiles wide).
  for (let i = 0; i <= COLS / 2; i++) {
    const line = MARGIN + i * 2 * CELL;
    for (let t = MARGIN - 2; t < W - MARGIN + 2; t++) {
      for (const d of [-1, 0]) {
        const a = line + d;
        if (a < 0 || a >= W || t < 0 || t >= H) continue;
        if (!taken[t * W + a]) ground[t * W + a] = 1;
        if (!taken[a * W + t]) ground[a * W + t] = 1;
      }
    }
  }
  for (let i = 0; i < W * H; i++) if (ground[i] === 1) taken[i] = 1;

  // Graveyards at the centre of each block.
  const graveyards: Graveyard[] = [];
  const props: Prop[] = [];
  const put = (path: string, px: number, py: number) => props.push({ f: fileIndex(path), x: Math.round(px), y: Math.round(py) });
  for (let br = 0; br < COLS / 2; br++) {
    for (let bc = 0; bc < COLS / 2; bc++) {
      const jx = MARGIN + (bc * 2 + 1) * CELL;
      const jy = MARGIN + (br * 2 + 1) * CELL;
      const gx = jx - 2;
      const gy = jy - 2;
      const id = graveyards.length;
      const cells: [number, number][] = [];
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if ((x + y) % 2 === 0 || rnd() < 0.3) cells.push([x, y]);
      for (let i = cells.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [cells[i], cells[j]] = [cells[j]!, cells[i]!];
      }
      const count = ri(6, 10);
      const graves = cells.slice(0, count).map(([x, y]) => ({ x: gx + x, y: gy + y, kind: ri(0, 3) }));
      const serves = plots.filter((p) => p.graveyard === id).map((p) => p.id);
      graveyards.push({ id, x: gx, y: gy, w: 5, h: 5, graves, serves });
      for (let y = gy - 1; y < gy + 6; y++)
        for (let x = gx - 1; x < gx + 6; x++) {
          const edge = x === gx - 1 || y === gy - 1 || x === gx + 5 || y === gy + 5;
          if (!edge || rnd() < 0.45) ground[y * W + x] = 2;
        }
      take(gx - 1, gy - 1, 7, 7);
      // Dead scenery and a broken fence around the patch.
      put(SPECIAL.deadTree, (gx - 1) * 16 + 4, (gy - 1) * 16 + 14);
      put(SPECIAL.stump, (gx + 6) * 16 + 2, (gy + 5) * 16 + 12);
      for (let x = gx; x < gx + 5; x++) if (rnd() < 0.55) put(SPECIAL.fenceH, x * 16 + 8, (gy + 5) * 16 + 15);
      for (let y = gy; y < gy + 5; y++) if (rnd() < 0.45) put(SPECIAL.fenceV, (gx - 1) * 16 + 8, y * 16 + 16);
    }
  }

  // Scenery: weighted random props wherever there's room.
  const total = SCENERY.reduce((a, d) => a + d.w, 0);
  const pick = () => {
    let r = rnd() * total;
    for (const d of SCENERY) if ((r -= d.w) <= 0) return d;
    return SCENERY[0]!;
  };
  for (let n = 0; n < 9000 && props.length < 900; n++) {
    const d = pick();
    const tx = ri(0, W - d.t[0]);
    const ty = ri(1, H - d.t[1]);
    if (!free(tx - 1, ty - 1, d.t[0] + 1, d.t[1] + 1)) continue;
    take(tx, ty, d.t[0], d.t[1]);
    put(d.p, tx * 16 + (d.t[0] * 16) / 2, (ty + d.t[1]) * 16);
  }
  props.sort((a, b) => a.y - b.y || a.x - b.x);
  return { w: W, h: H, plots, graveyards, props, ground };
}

/** World tile coordinates of a plot's Main Tower centre. */
export function hqCenter(p: WorldPlot): [number, number] {
  return [p.x + HQ_RECT.x + HQ_RECT.w / 2, p.y + HQ_RECT.y + HQ_RECT.h / 2];
}
