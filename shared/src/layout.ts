// The fixed base layout every player shares: a 20x20 tile map with a walled compound in the middle,
// the Main Tower (HQ) at its centre and 8 fixed build slots for survivor posts.

export const GRID = 20;

/** Wall ring (inclusive tile coordinates). */
export const RING = { x0: 3, y0: 3, x1: 16, y1: 16 };

/** HQ footprint in tiles (top-left + size). */
export const HQ_RECT = { x: 8, y: 9, w: 3, h: 2 };

/** Post slots, in unlock order (slot i unlocks when slotsUnlocked(hq) > i). One tile each. */
export const SLOTS: { x: number; y: number }[] = [
  { x: 6, y: 6 },
  { x: 13, y: 6 },
  { x: 6, y: 13 },
  { x: 13, y: 13 },
  { x: 9, y: 5 },
  { x: 9, y: 14 },
  { x: 5, y: 9 },
  { x: 14, y: 10 },
];

export type Side = 'n' | 'e' | 's' | 'w';
export const SIDES: Side[] = ['n', 'e', 's', 'w'];

export interface WallTile {
  /** Stable index along the ring (used as an id). */
  i: number;
  x: number;
  y: number;
  /** Which way the segment runs, for picking the sprite. */
  dir: 'h' | 'v';
}

/** Every wall segment of the ring, clockwise from the top-left corner. */
export const WALLS: WallTile[] = (() => {
  const out: WallTile[] = [];
  const { x0, y0, x1, y1 } = RING;
  for (let x = x0; x <= x1; x++) out.push({ i: out.length, x, y: y0, dir: 'h' });
  for (let y = y0 + 1; y <= y1; y++) out.push({ i: out.length, x: x1, y, dir: 'v' });
  for (let x = x1 - 1; x >= x0; x--) out.push({ i: out.length, x, y: y1, dir: 'h' });
  for (let y = y1 - 1; y > y0; y--) out.push({ i: out.length, x: x0, y, dir: 'v' });
  return out;
})();
