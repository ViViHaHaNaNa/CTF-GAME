// The fixed layout of one base, in tiles relative to its plot's top-left corner.
// Every plot in the world is PLOT x PLOT tiles: a walled compound with a 2-tile apron around it
// (the apron is where raiders deploy in PvP).

export const PLOT = 14;

/** Wall ring (inclusive, plot-local tile coordinates). */
export const RING = { x0: 2, y0: 2, x1: 11, y1: 11 };

/** Main Tower footprint (plot-local). */
export const HQ_RECT = { x: 5, y: 6, w: 3, h: 2 };

/** Post slots in unlock order (slot i unlocks when slotsUnlocked(hq) > i). One tile each. */
export const SLOTS: { x: number; y: number }[] = [
  { x: 4, y: 4 },
  { x: 9, y: 4 },
  { x: 4, y: 9 },
  { x: 9, y: 9 },
  { x: 7, y: 4 },
  { x: 6, y: 9 },
  { x: 3, y: 7 },
  { x: 10, y: 6 },
];

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

/** Raiders may only be deployed on the apron: inside the plot, outside the walls. */
export function inDeployZone(localX: number, localY: number): boolean {
  if (localX < 0 || localY < 0 || localX >= PLOT || localY >= PLOT) return false;
  return localX < RING.x0 || localX >= RING.x1 + 1 || localY < RING.y0 || localY >= RING.y1 + 1;
}
