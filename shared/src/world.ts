import { mulberry32 } from './engine.ts';
import { HQ_RECT, PLOT } from './layout.ts';

// The shared open world. Generated from a fixed seed with shared code, so the server and every client
// build exactly the same map without shipping a layout file.
//
// A dense little city: 64 compounds in a 4x4 grid of city blocks, each block 2x2 compounds. Inside a
// block, compounds are 2 tiles apart (alleys); blocks are separated by 4-tile streets. Where a block's
// alleys cross sits its graveyard, sending zombies to the 4 bases around it (a ~5 tile diagonal walk
// that never crosses another compound). A belt of wasteland scenery surrounds the city.

export const WORLD_SEED = 0x51e6e;
/** Gap between the two compounds of a block row/column. */
export const ALLEY = 2;
/** Width of the streets between blocks (and around the city). */
export const STREET = 4;
const BLOCKS = 4;
/** Scenery belt around the city. */
const MARGIN = 8;
const BLOCK = PLOT * 2 + ALLEY;
export const WORLD_W = MARGIN * 2 + STREET * (BLOCKS + 1) + BLOCK * BLOCKS;
export const WORLD_H = WORLD_W;
/** Left/top tile of block i (column or row). */
const blockAt = (i: number) => MARGIN + STREET + i * (BLOCK + STREET);

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

export interface Street {
  /** Tiles: the full street strip. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 'v' runs top to bottom, 'h' left to right. */
  dir: 'h' | 'v';
}

export interface World {
  w: number;
  h: number;
  plots: WorldPlot[];
  graveyards: Graveyard[];
  props: Prop[];
  /** Per tile: 0 open ground, 1 street, 2 mud (graveyard), 3 alley. */
  ground: Uint8Array;
  /** Streets between blocks (for lane markings). */
  streets: Street[];
  /** Tile at the middle of the map: the central crossroads, where crates land. */
  centre: [number, number];
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

  // Plots: 8x8, in 2x2 city blocks. Ids are row-major and graveyard = block index.
  const plots: WorldPlot[] = [];
  for (let r = 0; r < BLOCKS * 2; r++) {
    for (let c = 0; c < BLOCKS * 2; c++) {
      const x = blockAt(Math.floor(c / 2)) + (c % 2) * (PLOT + ALLEY);
      const y = blockAt(Math.floor(r / 2)) + (r % 2) * (PLOT + ALLEY);
      const graveyard = Math.floor(r / 2) * BLOCKS + Math.floor(c / 2);
      plots.push({ id: plots.length, x, y, order: 0, graveyard });
      take(x, y, PLOT, PLOT);
    }
  }
  const mid = W / 2;
  [...plots]
    .sort((a, b) => Math.hypot(a.x + PLOT / 2 - mid, a.y + PLOT / 2 - mid) - Math.hypot(b.x + PLOT / 2 - mid, b.y + PLOT / 2 - mid) || a.id - b.id)
    .forEach((p, i) => (p.order = i));

  // Streets around and between the blocks; alleys inside each block.
  const streets: Street[] = [];
  const cityLo = MARGIN;
  const cityHi = W - MARGIN;
  for (let i = 0; i <= BLOCKS; i++) {
    const at = MARGIN + i * (BLOCK + STREET);
    streets.push({ x: at, y: cityLo, w: STREET, h: cityHi - cityLo, dir: 'v' });
    streets.push({ x: cityLo, y: at, w: cityHi - cityLo, h: STREET, dir: 'h' });
    for (let t = cityLo; t < cityHi; t++)
      for (let d = 0; d < STREET; d++) {
        ground[t * W + at + d] = 1;
        ground[(at + d) * W + t] = 1;
      }
  }
  for (let br = 0; br < BLOCKS; br++)
    for (let bc = 0; bc < BLOCKS; bc++) {
      const bx = blockAt(bc);
      const by = blockAt(br);
      for (let t = 0; t < BLOCK; t++)
        for (let d = 0; d < ALLEY; d++) {
          ground[(by + t) * W + bx + PLOT + d] = 3;
          ground[(by + PLOT + d) * W + bx + t] = 3;
        }
    }
  for (let i = 0; i < W * H; i++) if (ground[i] === 1 || ground[i] === 3) taken[i] = 1;

  // Graveyards where each block's alleys cross. Graves stay on the alley (never inside a plot);
  // the mud spills a little into the neighbouring yards' corners.
  const graveyards: Graveyard[] = [];
  const props: Prop[] = [];
  const put = (path: string, px: number, py: number) => props.push({ f: fileIndex(path), x: Math.round(px), y: Math.round(py) });
  for (let br = 0; br < BLOCKS; br++) {
    for (let bc = 0; bc < BLOCKS; bc++) {
      const jx = blockAt(bc) + PLOT;
      const jy = blockAt(br) + PLOT;
      const gx = jx - 2;
      const gy = jy - 2;
      const id = graveyards.length;
      // Alley tiles around the crossing, minus the 2x2 crossing itself (kept as the zombies' gathering spot).
      const cells: [number, number][] = [];
      for (let y = gy - 1; y < gy + 7; y++)
        for (let x = gx - 1; x < gx + 7; x++) {
          const inCrossing = (x === jx || x === jx + 1) && (y === jy || y === jy + 1);
          if (ground[y * W + x] === 3 && !inCrossing) cells.push([x, y]);
        }
      for (let i = cells.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [cells[i], cells[j]] = [cells[j]!, cells[i]!];
      }
      const count = ri(6, Math.min(10, cells.length - 1));
      const graves = cells.slice(0, count).map(([x, y]) => ({ x, y, kind: ri(0, 3) }));
      const serves = plots.filter((p) => p.graveyard === id).map((p) => p.id);
      graveyards.push({ id, x: gx, y: gy, w: 6, h: 6, graves, serves });
      for (let y = gy - 1; y < gy + 7; y++)
        for (let x = gx - 1; x < gx + 7; x++) {
          const edge = x === gx - 1 || y === gy - 1 || x === gx + 6 || y === gy + 6;
          if (!edge || rnd() < 0.4) ground[y * W + x] = 2;
        }
      // A dead tree on one of the free alley tiles.
      const [tx, ty] = cells[count]!;
      put(SPECIAL.deadTree, tx * 16 + 8, ty * 16 + 15);
    }
  }

  // Wrecks, barrels and junk along the streets, against the kerb (the middle lanes stay clear).
  const STREET_JUNK: { p: string; t: [number, number]; dir: 'h' | 'v' | 'any'; w: number }[] = [
    { p: V + '/Rust/Car_1_Rust/Car_1_Rust_Red.png', t: [2, 3], dir: 'v', w: 2 },
    { p: V + '/Rust/Car_2_Rust_Upsidedown/Car_2_Rust_Blue_Upsidedown.png', t: [2, 3], dir: 'v', w: 1 },
    { p: V + '/Rust/Car_4_Rust/Car_4_Rust_Green.png', t: [3, 2], dir: 'h', w: 2 },
    { p: V + '/Rust/Car_6_Rust_Scrap/Car_6_Rust_Orange_Scrap.png', t: [3, 2], dir: 'h', w: 1.5 },
    { p: 'Objects/Barrel_rust_red_1.png', t: [1, 1], dir: 'any', w: 3 },
    { p: 'Objects/Barrel_rust_blue_2.png', t: [1, 1], dir: 'any', w: 2 },
    { p: 'Objects/Traffic-cone.png', t: [1, 1], dir: 'any', w: 2 },
    { p: 'Objects/Tire_1.png', t: [1, 1], dir: 'any', w: 1.5 },
    { p: 'Objects/Trash-bag_1.png', t: [1, 1], dir: 'any', w: 1.5 },
  ];
  const junkTotal = STREET_JUNK.reduce((a, d) => a + d.w, 0);
  const junkUsed = new Uint8Array(W * H);
  const clearStreet = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (ground[yy * W + xx] !== 1 || junkUsed[yy * W + xx]) return false;
    return true;
  };
  for (const st of streets) {
    const len = st.dir === 'v' ? st.h : st.w;
    for (let at = 2; at < len - 3; at += ri(3, 6)) {
      if (rnd() < 0.45) continue;
      let r = rnd() * junkTotal;
      let d = STREET_JUNK[0]!;
      for (const j of STREET_JUNK) {
        r -= j.w;
        if (r <= 0) {
          d = j;
          break;
        }
      }
      if (d.dir !== 'any' && d.dir !== st.dir) continue;
      const farKerb = rnd() < 0.5;
      const [tw, th] = d.t;
      const x = st.dir === 'v' ? (farKerb ? st.x + st.w - tw : st.x) : st.x + at;
      const y = st.dir === 'v' ? st.y + at : farKerb ? st.y + st.h - th : st.y;
      if (!clearStreet(x, y, tw, th)) continue;
      for (let yy = y - 1; yy <= y + th; yy++) for (let xx = x - 1; xx <= x + tw; xx++) if (yy >= 0 && xx >= 0 && yy < H && xx < W) junkUsed[yy * W + xx] = 1;
      put(d.p, x * 16 + (tw * 16) / 2, (y + th) * 16);
    }
  }

  // Scenery: weighted random props wherever there's room.
  const total = SCENERY.reduce((a, d) => a + d.w, 0);
  const pick = () => {
    let r = rnd() * total;
    for (const d of SCENERY) if ((r -= d.w) <= 0) return d;
    return SCENERY[0]!;
  };
  for (let n = 0; n < 12000 && props.length < 700; n++) {
    const d = pick();
    const tx = ri(0, W - d.t[0]);
    const ty = ri(1, H - d.t[1]);
    if (!free(tx - 1, ty - 1, d.t[0] + 1, d.t[1] + 1)) continue;
    take(tx, ty, d.t[0], d.t[1]);
    put(d.p, tx * 16 + (d.t[0] * 16) / 2, (ty + d.t[1]) * 16);
  }
  props.sort((a, b) => a.y - b.y || a.x - b.x);
  return { w: W, h: H, plots, graveyards, props, ground, streets, centre: [W / 2, W / 2] };
}

/** World tile coordinates of a plot's Main Tower centre. */
export function hqCenter(p: WorldPlot): [number, number] {
  return [p.x + HQ_RECT.x + HQ_RECT.w / 2, p.y + HQ_RECT.y + HQ_RECT.h / 2];
}
