import {
  CONFIG,
  HQ_ID,
  HQ_RECT,
  PLOT,
  POST_TYPES,
  RING,
  SLOTS,
  UNIT_KINDS,
  WALLS,
  ALLEY,
  getWorld,
  inDeployZone,
  postId,
  slotsUnlocked,
  wallId,
  type BaseState,
  type BaseSummary,
  type PostType,
  type RaidStatus,
  type Snapshot,
  type Rarity,
  type WorldPlot,
} from '@siege/shared';
import { LAYER_OFFSET, drawFrame, type Sheet, type Sprites } from './sprites.ts';

// Renders the shared world: a camera over one big pixel map at integer zoom (no smoothing).
// Ground + scenery are baked into chunks once; distant bases are cached static sprites; only bases
// with a live stream (the ones this screen watches) get full animation. Pure rendering.

const T = 16;
const CHUNK = 32; // tiles per chunk side
const SNAP_MS = (1000 * CONFIG.snapshotEvery) / CONFIG.tickRate;
const world = getWorld();
const WPX = world.w * T;
const HPX = world.h * T;

/** Crossroads in the middle of the map, where global crates land (world px). */
export const CRATE_SPOT = { x: world.centre[0] * T, y: world.centre[1] * T + 8 };
const CRATE_GLOW: Record<Rarity, string> = { rare: '143, 196, 107', epic: '110, 160, 230', legendary: '224, 87, 63' };

export type BasePick = { kind: 'hq' } | { kind: 'walls' } | { kind: 'slot'; slot: number };

interface UnitView {
  id: number;
  kind: number;
  px: number;
  py: number;
  x: number;
  y: number;
  hp: number;
  state: number;
  facing: number;
  diedAt: number;
  bornAt: number;
}

/** Live action on one watched plot. */
export interface LiveState {
  phase: 'calm' | 'warning' | 'wave' | 'raid';
  /** Local ms when zombies rise (calm / warning). */
  riseAt: number;
  units: Map<number, UnitView>;
  hp: Map<number, number>;
  tracers: { x0: number; y0: number; x1: number; y1: number; at: number }[];
  puffs: { x: number; y: number; at: number }[];
  postFacing: Map<number, number>;
  lastShot: Map<number, number>;
  lastSnapAt: number;
  raid: RaidStatus | null;
}

const ZOMBIE_SHEETS: Record<string, { walk: keyof Sprites; attack: keyof Sprites; death: keyof Sprites }> = {
  z_small: { walk: 'zSmallWalk', attack: 'zSmallAttack', death: 'zSmallDeath' },
  z_big: { walk: 'zBigWalk', attack: 'zBigAttack', death: 'zBigDeath' },
  z_axe: { walk: 'zAxeWalk', attack: 'zAxeAttack', death: 'zAxeDeath' },
};

/** Raider looks: body + weapon (+ helmet), tinted red so they never read as defenders. */
const RAIDER_LOOK: Record<string, { weapon: 'bat' | 'pistol' | 'shotgun'; helmet: boolean }> = {
  r_bat: { weapon: 'bat', helmet: false },
  r_pistol: { weapon: 'pistol', helmet: false },
  r_helmet: { weapon: 'bat', helmet: true },
  r_shotgun: { weapon: 'shotgun', helmet: false },
};

function hash(x: number, y: number, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Plot-level base description, from the world summary (or the player's own fresher state). */
function baseOf(s: BaseSummary): BaseState {
  return { hq: s.hq, walls: s.walls, posts: s.posts.map((p) => (p ? { type: POST_TYPES[p[0]]!, level: p[1] } : null)) };
}

export class WorldView {
  readonly g: CanvasRenderingContext2D;
  /**
   * Camera: world px at the screen centre; k = device pixels per art pixel as drawn this frame.
   * `zoom` is the integer level k eases toward, so the art is pixel-crisp whenever the camera rests.
   */
  cam = { x: WPX / 2, y: HPX / 2, k: 2 };
  zoom = 2;
  /** Device point held still while the zoom eases (cursor or pinch centre). */
  private anchor: [number, number] | null = null;
  /** True while fingers/trackpad drive the zoom directly (no easing until released). */
  private holding = false;
  /** Momentum after a drag, in world px per ms. */
  private vx = 0;
  private vy = 0;
  private lastUpdate = 0;
  private tagCache = new Map<number, { key: string; canvas: HTMLCanvasElement }>();
  bases = new Map<number, BaseSummary>();
  live = new Map<number, LiveState>();
  /** The viewer's own plot and base (fresher than the summary). */
  myPlot = -1;
  myBase: BaseState | null = null;
  selectedPlot = -1;
  selectedPick: BasePick | null = null;
  /** Plot being raided by this viewer: draw its deploy zone. */
  deployPlot = -1;
  /** Server clock offset (server - local ms), for shield countdowns. */
  clockSkew = 0;
  /** The unclaimed global crate, drawn at the crossroads in the middle of the map. */
  crate: { rarity: Rarity } | null = null;
  private chunks = new Map<number, HTMLCanvasElement | ImageBitmap>();
  private baseCache = new Map<number, { key: string; canvas: HTMLCanvasElement }>();
  private ruinCache = new Map<number, HTMLCanvasElement>();
  private composites = new Map<string, HTMLCanvasElement>();

  /** World size in art pixels (it's square). */
  readonly worldPx = WPX;

  constructor(readonly canvas: HTMLCanvasElement, readonly sprites: Sprites) {
    this.g = canvas.getContext('2d')!;
  }

  // ---- camera -----------------------------------------------------------------------------------

  get dpr() {
    return window.devicePixelRatio || 1;
  }

  fit(cssW: number, cssH: number) {
    const w = Math.max(1, Math.round(cssW * this.dpr));
    const h = Math.max(1, Math.round(cssH * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
    }
    this.clamp();
  }

  get kMin() {
    return 1;
  }
  get kMax() {
    return Math.max(4, Math.round(4 * this.dpr));
  }

  /** Default zoom: a neighbourhood, about 3-4 bases across on a landscape screen, 2 on a phone. */
  overviewZoom(): number {
    const period = (PLOT + ALLEY) * T;
    const across = this.canvas.width >= this.canvas.height ? 3.6 : 2.2;
    return Math.max(this.kMin, Math.min(this.kMax, Math.floor(this.canvas.width / (across * period))));
  }

  /** A zoom that shows one whole base comfortably. */
  baseZoom(): number {
    const fit = Math.floor((Math.min(this.canvas.width, this.canvas.height) * 0.85) / (PLOT * T));
    return Math.max(this.kMin, Math.min(this.kMax, fit));
  }

  clamp() {
    const c = this.cam;
    c.k = Math.max(this.kMin, Math.min(this.kMax, c.k));
    this.zoom = Math.max(this.kMin, Math.min(this.kMax, Math.round(this.zoom)));
    const hw = this.canvas.width / 2 / c.k;
    const hh = this.canvas.height / 2 / c.k;
    c.x = hw * 2 >= WPX ? WPX / 2 : Math.max(hw, Math.min(WPX - hw, c.x));
    c.y = hh * 2 >= HPX ? HPX / 2 : Math.max(hh, Math.min(HPX - hh, c.y));
  }

  /** Draw at zoom k while keeping the world point under device point (ax, ay) still. */
  private setK(k: number, ax: number, ay: number) {
    const c = this.cam;
    const w2 = this.canvas.width / 2;
    const h2 = this.canvas.height / 2;
    const wx = (ax - w2) / c.k + c.x;
    const wy = (ay - h2) / c.k + c.y;
    c.k = Math.max(this.kMin, Math.min(this.kMax, k));
    c.x = wx - (ax - w2) / c.k;
    c.y = wy - (ay - h2) / c.k;
    this.clamp();
  }

  /** Zoom one level in (+1) or out (-1), easing toward the point under (sx, sy) in CSS px. */
  zoomAt(step: number, sx: number, sy: number) {
    this.holding = false;
    this.zoom = Math.max(this.kMin, Math.min(this.kMax, this.zoom + step));
    this.anchor = [sx * this.dpr, sy * this.dpr];
  }

  /** Follow a pinch / trackpad zoom exactly (any in-between level) until settleZoom(). */
  zoomFree(k: number, sx: number, sy: number) {
    this.holding = true;
    this.anchor = [sx * this.dpr, sy * this.dpr];
    this.setK(k, this.anchor[0], this.anchor[1]);
  }

  /** Fingers lifted: ease to the nearest crisp level. */
  settleZoom() {
    if (!this.holding) return;
    this.holding = false;
    this.zoom = Math.round(this.cam.k);
    this.clamp();
  }

  panBy(dxCss: number, dyCss: number) {
    this.cam.x -= (dxCss * this.dpr) / this.cam.k;
    this.cam.y -= (dyCss * this.dpr) / this.cam.k;
    this.clamp();
  }

  /** Let go of a drag moving at (vx, vy) CSS px per ms: the map glides on and slows down. */
  fling(vxCss: number, vyCss: number) {
    this.vx = (-vxCss * this.dpr) / this.cam.k;
    this.vy = (-vyCss * this.dpr) / this.cam.k;
  }

  stopFling() {
    this.vx = 0;
    this.vy = 0;
  }

  /** Jump the camera (no easing), optionally to an integer zoom. */
  jumpTo(wx: number, wy: number, k?: number) {
    this.stopFling();
    this.cam.x = wx;
    this.cam.y = wy;
    if (k) {
      this.cam.k = k;
      this.zoom = k;
      this.holding = false;
      this.anchor = null;
    }
    this.clamp();
  }

  centerOnPlot(plot: number, k?: number) {
    const p = world.plots[plot];
    if (p) this.jumpTo((p.x + PLOT / 2) * T, (p.y + PLOT / 2) * T, k);
  }

  /** The default view: the plot's city block (its 4 compounds around the graveyard) at overview zoom. */
  centerOnBlock(plot: number) {
    const p = world.plots[plot];
    const g = p && world.graveyards[p.graveyard];
    if (g) this.jumpTo((g.x + g.w / 2) * T, (g.y + g.h / 2) * T, this.overviewZoom());
  }

  /** Advance zoom easing and momentum; call once per animation frame before draw(). */
  update(now: number) {
    const dt = Math.min(50, this.lastUpdate ? now - this.lastUpdate : 16);
    this.lastUpdate = now;
    const c = this.cam;
    if (!this.holding && c.k !== this.zoom) {
      const [ax, ay] = this.anchor ?? [this.canvas.width / 2, this.canvas.height / 2];
      // Exponential ease: ~90% of the way in 140 ms whatever the frame rate.
      const next = Math.abs(this.zoom - c.k) < 0.01 ? this.zoom : c.k + (this.zoom - c.k) * (1 - Math.exp(-dt / 60));
      this.setK(next, ax, ay);
      if (c.k === this.zoom) this.anchor = null;
    }
    if (this.vx || this.vy) {
      c.x += this.vx * dt;
      c.y += this.vy * dt;
      const f = Math.exp(-dt / 325);
      this.vx *= f;
      this.vy *= f;
      if (Math.hypot(this.vx, this.vy) * c.k < 0.02) this.stopFling();
      this.clamp();
    }
  }

  /** Bake every ground/scenery chunk now (a one-off ~60 ms), so panning never stalls to bake one. */
  prebake() {
    for (let cy = 0; cy < Math.ceil(world.h / CHUNK); cy++) for (let cx = 0; cx < Math.ceil(world.w / CHUNK); cx++) this.chunk(cx, cy);
  }

  /** CSS px (relative to the canvas) -> world px. */
  toWorld(cssX: number, cssY: number): [number, number] {
    const c = this.cam;
    return [(cssX * this.dpr - this.canvas.width / 2) / c.k + c.x, (cssY * this.dpr - this.canvas.height / 2) / c.k + c.y];
  }

  /** World px -> device px on the canvas. */
  toScreen(wx: number, wy: number): [number, number] {
    const c = this.cam;
    return [(wx - c.x) * c.k + this.canvas.width / 2, (wy - c.y) * c.k + this.canvas.height / 2];
  }

  viewRect(): [number, number, number, number] {
    const c = this.cam;
    const hw = this.canvas.width / 2 / c.k;
    const hh = this.canvas.height / 2 / c.k;
    return [c.x - hw, c.y - hh, c.x + hw, c.y + hh];
  }

  /** Plots worth streaming: in view and close enough to see combat, nearest first. */
  plotsOfInterest(max: number): number[] {
    if (this.zoom < 2) return [];
    const [x0, y0, x1, y1] = this.viewRect();
    return world.plots
      .filter((p) => this.bases.has(p.id) && (p.x + PLOT) * T > x0 && p.x * T < x1 && (p.y + PLOT) * T > y0 && p.y * T < y1)
      .map((p) => ({ id: p.id, d: Math.hypot((p.x + PLOT / 2) * T - this.cam.x, (p.y + PLOT / 2) * T - this.cam.y) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, max)
      .map((p) => p.id);
  }

  // ---- hit testing --------------------------------------------------------------------------------

  plotAt(wx: number, wy: number): WorldPlot | undefined {
    const tx = wx / T;
    const ty = wy / T;
    return world.plots.find((p) => tx >= p.x && tx < p.x + PLOT && ty >= p.y && ty < p.y + PLOT);
  }

  /** What part of a base sits under a world point. */
  pickInBase(p: WorldPlot, wx: number, wy: number): BasePick | null {
    const tx = Math.floor(wx / T) - p.x;
    const ty = Math.floor(wy / T) - p.y;
    if (tx >= HQ_RECT.x && tx < HQ_RECT.x + HQ_RECT.w && ty >= HQ_RECT.y - 1 && ty < HQ_RECT.y + HQ_RECT.h) return { kind: 'hq' };
    const slot = SLOTS.findIndex((s) => s.x === tx && (s.y === ty || s.y - 1 === ty));
    if (slot >= 0) return { kind: 'slot', slot };
    const onRing = (tx === RING.x0 || tx === RING.x1 || ty === RING.y0 || ty === RING.y1) && tx >= RING.x0 && tx <= RING.x1 && ty >= RING.y0 && ty <= RING.y1;
    return onRing ? { kind: 'walls' } : null;
  }

  inDeploy(plot: number, wx: number, wy: number): boolean {
    const p = world.plots[plot];
    return !!p && inDeployZone(Math.floor(wx / T) - p.x, Math.floor(wy / T) - p.y);
  }

  // ---- live streams -----------------------------------------------------------------------------

  liveFor(plot: number): LiveState {
    let l = this.live.get(plot);
    if (!l) {
      l = { phase: 'calm', riseAt: 0, units: new Map(), hp: new Map(), tracers: [], puffs: [], postFacing: new Map(), lastShot: new Map(), lastSnapAt: 0, raid: null };
      this.live.set(plot, l);
    }
    return l;
  }

  resetCombat(plot: number) {
    const l = this.liveFor(plot);
    l.units.clear();
    l.hp.clear();
    l.tracers = [];
    l.puffs = [];
  }

  applySnapshot(plot: number, s: Snapshot, now: number) {
    const l = this.liveFor(plot);
    const seen = new Set<number>();
    for (const [id, kind, x, y, hp, state, facing] of s.u) {
      seen.add(id);
      const u = l.units.get(id);
      if (u) {
        u.px = u.x;
        u.py = u.y;
        u.x = x;
        u.y = y;
        u.hp = hp;
        if (state === 2 && u.state !== 2) u.diedAt = now;
        u.state = state;
        u.facing = facing;
      } else {
        l.units.set(id, { id, kind, px: x, py: y, x, y, hp, state, facing, diedAt: state === 2 ? now : 0, bornAt: now });
        if (state === 3) l.puffs.push({ x, y, at: now });
      }
    }
    for (const id of l.units.keys()) if (!seen.has(id)) l.units.delete(id);
    for (const [id, hp] of s.b) l.hp.set(id, hp);
    const p = world.plots[plot]!;
    for (const [sid, tx, ty] of s.s) {
      if (sid >= 200 && sid < 300) {
        const sl = SLOTS[sid - 200];
        if (!sl) continue;
        const x0 = (p.x + sl.x) * T + 8;
        const y0 = (p.y + sl.y) * T + 4;
        l.postFacing.set(sid, tx >= x0 ? 1 : -1);
        l.lastShot.set(sid, now);
        l.tracers.push({ x0, y0, x1: tx, y1: ty - 6, at: now });
      } else {
        const u = l.units.get(sid);
        if (u) l.tracers.push({ x0: u.x, y0: u.y - 8, x1: tx, y1: ty, at: now });
      }
    }
    l.lastSnapAt = now;
  }

  // ---- drawing ------------------------------------------------------------------------------------

  draw(now: number) {
    const g = this.g;
    const c = this.cam;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#15120e';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const ox = Math.round(this.canvas.width / 2 - c.x * c.k);
    const oy = Math.round(this.canvas.height / 2 - c.y * c.k);
    g.imageSmoothingEnabled = false;
    const [x0, y0, x1, y1] = this.viewRect();

    // 1. Ground + scenery chunks, placed on whole device pixels so no seams show mid-zoom.
    const cs = CHUNK * T;
    for (let cy = Math.max(0, Math.floor(y0 / cs)); cy <= Math.min(Math.ceil(world.h / CHUNK) - 1, Math.floor(y1 / cs)); cy++)
      for (let cx = Math.max(0, Math.floor(x0 / cs)); cx <= Math.min(Math.ceil(world.w / CHUNK) - 1, Math.floor(x1 / cs)); cx++) {
        const dx = Math.round(ox + cx * cs * c.k);
        const dy = Math.round(oy + cy * cs * c.k);
        g.drawImage(this.chunk(cx, cy), dx, dy, Math.round(ox + (cx + 1) * cs * c.k) - dx, Math.round(oy + (cy + 1) * cs * c.k) - dy);
      }
    g.setTransform(c.k, 0, 0, c.k, ox, oy);

    // 2. Bases and ruins in view.
    const visible = world.plots.filter((p) => (p.x + PLOT) * T > x0 - 16 && p.x * T < x1 && (p.y + PLOT) * T + 16 > y0 && p.y * T - 24 < y1);
    for (const p of visible) {
      const s = this.bases.get(p.id);
      if (!s) {
        g.drawImage(this.ruins(p.id), p.x * T, p.y * T - 8);
        continue;
      }
      const l = this.live.get(p.id);
      const detailed = !!l && (l.phase === 'wave' || l.phase === 'raid' || l.units.size > 0 || p.id === this.myPlot);
      const base = p.id === this.myPlot && this.myBase ? this.myBase : baseOf(s);
      if (detailed) this.drawBaseLive(g, p, base, l!, now);
      else g.drawImage(this.staticBase(p.id, base), p.x * T, p.y * T - 16);
    }

    // 3. Graveyard warnings and deploy zone.
    for (const gy of world.graveyards) {
      if ((gy.x + 6) * T < x0 || gy.x * T > x1 || (gy.y + 6) * T < y0 || gy.y * T > y1) continue;
      const state = Math.max(0, ...gy.serves.map((id) => this.bases.get(id)?.wave ?? 0));
      if (state > 0) this.drawGraveWarning(g, gy.x, gy.y, state, now);
    }
    if (this.deployPlot >= 0) this.drawDeployZone(g, world.plots[this.deployPlot]!, now);
    if (this.selectedPlot >= 0 && this.selectedPick && this.selectedPlot === this.myPlot) this.drawPick(g, world.plots[this.myPlot]!, this.selectedPick, now);
    if (this.crate) this.drawCrate(g, this.crate.rarity, now);

    // 4. Screen-space labels (crisp text at any zoom).
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const p of visible) {
      const s = this.bases.get(p.id);
      if (s) this.drawTag(g, p, s, now);
    }
    if (this.crate) this.drawCrateTag(this.crate.rarity);
  }

  /** Is a world point on (or near) the crate? Generous, so it's easy to tap on a phone. */
  crateAt(wx: number, wy: number): boolean {
    return !!this.crate && Math.hypot(wx - CRATE_SPOT.x, wy - (CRATE_SPOT.y - 8)) < Math.max(18, 28 / this.cam.k);
  }

  private drawCrate(g: CanvasRenderingContext2D, rarity: Rarity, now: number) {
    const img = (rarity === 'legendary' ? this.sprites.crateRed : rarity === 'epic' ? this.sprites.crateBlue : this.sprites.crateGreen).img;
    const color = CRATE_GLOW[rarity];
    const { x, y } = CRATE_SPOT;
    const pulse = 0.5 + 0.5 * Math.sin(now / 300);
    // Beacon of light so it can be spotted from far away.
    g.fillStyle = `rgba(${color}, ${0.12 + 0.1 * pulse})`;
    g.fillRect(x - 3, y - 120, 6, 112);
    g.fillStyle = `rgba(${color}, ${0.25 + 0.2 * pulse})`;
    g.beginPath();
    g.ellipse(x, y, 14 + 3 * pulse, 6 + pulse, 0, 0, Math.PI * 2);
    g.fill();
    const bob = Math.round(Math.sin(now / 250) * 1.5);
    g.drawImage(img, Math.round(x - img.width), Math.round(y - img.height * 2 - 2 + bob), img.width * 2, img.height * 2);
  }

  private drawCrateTag(rarity: Rarity) {
    const g = this.g;
    const d = this.dpr;
    const [sx, sy] = this.toScreen(CRATE_SPOT.x, CRATE_SPOT.y - 26);
    const fs = Math.round(11 * d);
    const text = `${rarity.toUpperCase()} CRATE`;
    g.font = `800 ${fs}px system-ui, sans-serif`;
    const w = g.measureText(text).width + 10 * d;
    const h = fs + 6 * d;
    g.fillStyle = `rgba(${CRATE_GLOW[rarity]}, 0.92)`;
    g.fillRect(Math.round(sx - w / 2), Math.round(sy - h), w, h);
    g.fillStyle = '#1b1712';
    g.textBaseline = 'middle';
    g.fillText(text, Math.round(sx - w / 2 + 5 * d), Math.round(sy - h / 2 + d));
  }

  // ---- chunks (ground, roads, graveyards, scenery) ------------------------------------------------

  private chunk(cx: number, cy: number): HTMLCanvasElement | ImageBitmap {
    const key = cy * 1000 + cx;
    const hit = this.chunks.get(key);
    if (hit) return hit;
    const c = document.createElement('canvas');
    const size = CHUNK * T;
    c.width = size;
    c.height = size;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    const tiles = this.sprites.ground.img;
    const plain: [number, number][] = [[0, 0], [2, 0], [14, 0], [16, 0], [0, 2], [2, 2], [14, 2], [16, 2], [5, 0]];
    const decals: [number, number][] = [[3, 1], [4, 0], [3, 2]];
    for (let ty = 0; ty < CHUNK; ty++)
      for (let tx = 0; tx < CHUNK; tx++) {
        const wx = cx * CHUNK + tx;
        const wy = cy * CHUNK + ty;
        if (wx >= world.w || wy >= world.h) continue;
        const gk = world.ground[wy * world.w + wx];
        let src: [number, number];
        if (gk === 2) src = [15, 1];
        else if (gk === 1 || gk === 3) src = [1, 1];
        else {
          const set = hash(wx, wy) < 0.04 ? decals : plain;
          src = set[Math.floor(hash(wx, wy, 1) * set.length)]!;
        }
        g.drawImage(tiles, src[0] * T, src[1] * T, T, T, tx * T, ty * T, T, T);
      }
    const ox = cx * size;
    const oy = cy * size;
    // Graves.
    for (const gy of world.graveyards) {
      for (const gr of gy.graves) {
        const px = gr.x * T - ox;
        const py = gr.y * T - oy;
        if (px > -T && py > -T && px < size && py < size) g.drawImage(this.sprites.graves[gr.kind]!, px, py);
      }
    }
    // Scenery, already sorted by y.
    for (const pr of world.props) {
      const img = this.sprites.props[pr.f]!;
      const px = Math.round(pr.x - img.width / 2) - ox;
      const py = pr.y - img.height - oy;
      if (px + img.width < 0 || py + img.height < 0 || px > size || py > size) continue;
      g.drawImage(img, px, py);
    }
    this.chunks.set(key, c);
    // Swap in an immutable bitmap: the GPU keeps it ready instead of re-uploading the canvas.
    if (typeof createImageBitmap === 'function') void createImageBitmap(c).then((b) => this.chunks.set(key, b), () => {});
    return c;
  }

  /** Unclaimed plot: what's left of an abandoned compound (gapped, darkened walls and junk). */
  private ruins(plot: number): HTMLCanvasElement {
    const hit = this.ruinCache.get(plot);
    if (hit) return hit;
    const c = document.createElement('canvas');
    c.width = PLOT * T;
    c.height = PLOT * T + 8;
    const g = c.getContext('2d')!;
    const s = this.sprites;
    for (const w of WALLS) {
      const r = hash(w.x, w.y, plot);
      if (r < 0.5) {
        if (r < 0.12) g.drawImage(s.debris.img, w.x * T, w.y * T + 6);
        continue;
      }
      if (w.dir === 'h') g.drawImage(s.wallWoodH.img, w.x * T, w.y * T + 9);
      else g.drawImage(s.wallWoodV.img, w.x * T + 4, w.y * T + 8);
    }
    g.drawImage(s.bricks.img, (HQ_RECT.x + 1) * T + 2, (HQ_RECT.y + 1) * T + 4);
    g.drawImage(s.debris.img, HQ_RECT.x * T, HQ_RECT.y * T + 12);
    if (hash(plot, 7) > 0.5) g.drawImage(s.cardboard.img, (HQ_RECT.x + 3) * T, (HQ_RECT.y + 2) * T + 6);
    if (hash(plot, 9) > 0.4) g.drawImage(s.barrelRust.img, (RING.x0 + 2) * T, (RING.y1 - 2) * T);
    // Faded: nobody lives here.
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(40, 32, 24, 0.45)';
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
    this.ruinCache.set(plot, c);
    return c;
  }

  /** Packed-dirt yard inside a lived-in compound. */
  private drawYard(g: CanvasRenderingContext2D, ox: number, oy: number) {
    const tiles = this.sprites.ground.img;
    for (let y = RING.y0 + 1; y < RING.y1; y++)
      for (let x = RING.x0 + 1; x < RING.x1; x++) g.drawImage(tiles, 15 * T, 1 * T, T, T, ox + x * T, oy + y * T, T, T);
  }

  // ---- bases ----------------------------------------------------------------------------------------

  /** A base as one cached image: drawn this way when nothing is happening there or it's far away. */
  private staticBase(plot: number, base: BaseState): HTMLCanvasElement {
    const key = JSON.stringify(base);
    const hit = this.baseCache.get(plot);
    if (hit && hit.key === key) return hit.canvas;
    const c = document.createElement('canvas');
    c.width = PLOT * T;
    c.height = PLOT * T + 16;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    const fake = { x: 0, y: 1 } as WorldPlot; // drawn 16px down so antennas fit
    this.drawBaseItems(g, fake, base, null, 0, plot);
    this.baseCache.set(plot, { key, canvas: c });
    return c;
  }

  private drawBaseLive(g: CanvasRenderingContext2D, p: WorldPlot, base: BaseState, l: LiveState, now: number) {
    this.drawBaseItems(g, p, base, l, now, p.id);
  }

  /** Walls, Main Tower, posts and (when live) units, depth-sorted. */
  private drawBaseItems(g: CanvasRenderingContext2D, p: WorldPlot, base: BaseState, l: LiveState | null, now: number, plot: number) {
    const ox = p.x * T;
    const oy = p.y * T;
    this.drawYard(g, ox, oy);
    const items: { y: number; draw: () => void }[] = [];
    const reinforced = base.walls >= CONFIG.walls.reinforcedFromLevel;
    for (const w of WALLS) {
      const hp = l?.hp.get(wallId(w.i)) ?? 100;
      items.push({ y: oy + w.y * T + 14, draw: () => this.drawWall(g, ox + w.x * T, oy + w.y * T, w.dir, reinforced, hp) });
    }
    items.push({ y: oy + (HQ_RECT.y + HQ_RECT.h) * T, draw: () => this.drawHq(g, ox + HQ_RECT.x * T, oy + HQ_RECT.y * T, base.hq, l?.hp.get(HQ_ID) ?? 100) });
    const mine = plot === this.myPlot;
    const unlocked = slotsUnlocked(base.hq);
    SLOTS.forEach((s, i) => {
      const post = base.posts[i];
      if (post) items.push({ y: oy + s.y * T + 15, draw: () => this.drawPost(g, ox + s.x * T, oy + s.y * T, i, post.type, post.level, l, now) });
      else if (mine) items.push({ y: oy + s.y * T, draw: () => this.drawSlot(g, ox + s.x * T, oy + s.y * T, i < unlocked) });
    });
    if (l) for (const u of l.units.values()) {
      const [x, y] = this.unitPos(l, u, now);
      items.push({ y, draw: () => this.drawUnit(g, u, x, y, now) });
    }
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    if (l) this.drawEffects(g, l, now);
  }

  private unitPos(l: LiveState, u: UnitView, now: number): [number, number] {
    const a = Math.min(1, (now - l.lastSnapAt) / SNAP_MS);
    return [u.px + (u.x - u.px) * a, u.py + (u.y - u.py) * a];
  }

  private drawEffects(g: CanvasRenderingContext2D, l: LiveState, now: number) {
    l.tracers = l.tracers.filter((t) => now - t.at < 90);
    g.strokeStyle = 'rgba(255, 230, 140, 0.9)';
    g.lineWidth = 1;
    for (const t of l.tracers) {
      g.beginPath();
      g.moveTo(t.x0 + 0.5, t.y0 + 0.5);
      g.lineTo(t.x1 + 0.5, t.y1 + 0.5);
      g.stroke();
    }
    // Dirt puffs where zombies claw out of the ground.
    l.puffs = l.puffs.filter((p) => now - p.at < 600);
    for (const p of l.puffs) {
      const k = (now - p.at) / 600;
      g.fillStyle = `rgba(120, 96, 72, ${0.75 * (1 - k)})`;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const r = 2 + k * 7;
        g.fillRect(Math.round(p.x + Math.cos(a) * r), Math.round(p.y - 2 + Math.sin(a) * r * 0.5 - k * 3), 2, 2);
      }
    }
  }

  private drawWall(g: CanvasRenderingContext2D, x: number, y: number, dir: 'h' | 'v', reinforced: boolean, hp: number) {
    if (hp <= 0) {
      g.globalAlpha = 0.8;
      g.drawImage(this.sprites.debris.img, x + 1, y + 4);
      g.globalAlpha = 1;
      return;
    }
    if (dir === 'h') g.drawImage((reinforced ? this.sprites.wallReinH : this.sprites.wallWoodH).img, x, y + 1);
    else g.drawImage((reinforced ? this.sprites.wallReinV : this.sprites.wallWoodV).img, x + 4, y);
    if (hp < 100) this.hpBar(g, x + 2, y - 2, 12, hp);
  }

  private drawHq(g: CanvasRenderingContext2D, x: number, y: number, level: number, hp: number) {
    const s = this.sprites;
    const c = level >= 6 ? s.containerGreen : level >= 3 ? s.containerRed : s.containerGray;
    g.drawImage(s.pallet.img, x - 2, y + 18);
    g.drawImage(c.img, x + 3, y + 4);
    if (level >= 2) g.drawImage(s.antenna1.img, x + 6, y - 8);
    if (level >= 4) g.drawImage(s.hvac.img, x + 24, y - 2);
    if (level >= 3) g.drawImage(s.barrelRust.img, x + 40, y + 14);
    if (level >= 5) g.drawImage(s.barrelBlue.img, x - 8, y + 12);
    if (level >= 7) g.drawImage(s.antenna2.img, x + 30, y - 10);
    if (hp < 100) this.hpBar(g, x + 4, y - 4, 40, hp);
    for (let i = 0; i < level; i++) {
      g.fillStyle = '#1b1712';
      g.fillRect(x + 6 + i * 5, y + 31, 4, 3);
      g.fillStyle = '#e3b341';
      g.fillRect(x + 7 + i * 5, y + 31, 2, 2);
    }
  }

  /** Survivor (body + weapon + helmet) cached per look/frame; mirrored as a whole. */
  private survivor(weapon: 'pistol' | 'gun' | 'shotgun' | 'bat', helmet: boolean, frame: number, run: boolean, tint: string | null): HTMLCanvasElement {
    const key = `${weapon}${helmet ? 'h' : ''}${run ? 'r' : ''}${tint ?? ''}${frame}`;
    let c = this.composites.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = 28;
    c.height = 22;
    const g = c.getContext('2d')!;
    const s = this.sprites;
    const bx = 9;
    const by = 3;
    drawFrame(g, run ? s.bodyRun : s.body, frame, bx, by);
    if (helmet) drawFrame(g, s.helmet, frame, bx + LAYER_OFFSET.helmet.x, by + LAYER_OFFSET.helmet.y);
    drawFrame(g, s[weapon], frame, bx + LAYER_OFFSET[weapon].x, by + LAYER_OFFSET[weapon].y);
    if (tint) {
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = tint;
      g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'source-over';
    }
    this.composites.set(key, c);
    return c;
  }

  private drawPost(g: CanvasRenderingContext2D, x: number, y: number, slot: number, type: PostType, level: number, l: LiveState | null, now: number) {
    const id = postId(slot);
    const hp = l?.hp.get(id) ?? 100;
    if (hp > 0) {
      const frame = l ? Math.floor(now / 160 + slot) % 6 : 0;
      const img = this.survivor(type, level >= CONFIG.posts.helmetFromLevel, frame, false, null);
      const face = l?.postFacing.get(id) ?? (SLOTS[slot]!.x < PLOT / 2 ? -1 : 1);
      const ox = x + 8 - 14;
      const oy = y - 9;
      if (face < 0) {
        g.save();
        g.translate(ox + 28, oy);
        g.scale(-1, 1);
        g.drawImage(img, 0, 0);
        g.restore();
      } else g.drawImage(img, ox, oy);
      const shot = l?.lastShot.get(id) ?? -1e9;
      if (now - shot < 70) {
        const f = LAYER_OFFSET.fire[type];
        const fx = face > 0 ? ox + 9 + LAYER_OFFSET[type].x + f.x : ox + 28 - (9 + LAYER_OFFSET[type].x + f.x) - this.sprites.fire.fw;
        drawFrame(g, this.sprites.fire, Math.floor((now - shot) / 25), fx, oy + 3 + LAYER_OFFSET[type].y + f.y, face < 0);
      }
    }
    g.drawImage(this.sprites.wallWoodH.img, x, y + 6);
    g.fillStyle = '#1b1712';
    g.fillRect(x + 11, y + 11, 6, 6);
    g.fillStyle = '#e3b341';
    this.tinyDigit(g, level, x + 12, y + 12);
    if (hp < 100) this.hpBar(g, x + 1, y - 10, 14, hp);
  }

  private drawSlot(g: CanvasRenderingContext2D, x: number, y: number, unlocked: boolean) {
    g.fillStyle = unlocked ? 'rgba(227, 179, 65, 0.85)' : 'rgba(40, 34, 26, 0.6)';
    for (let i = 1; i < 15; i += 3) {
      g.fillRect(x + i, y + 1, 2, 1);
      g.fillRect(x + i, y + 14, 2, 1);
      g.fillRect(x + 1, y + i, 1, 2);
      g.fillRect(x + 14, y + i, 1, 2);
    }
    if (unlocked) {
      g.fillRect(x + 7, y + 5, 2, 6);
      g.fillRect(x + 5, y + 7, 6, 2);
    } else {
      g.fillStyle = 'rgba(30, 26, 20, 0.85)';
      g.fillRect(x + 5, y + 7, 6, 5);
      g.fillRect(x + 6, y + 4, 1, 3);
      g.fillRect(x + 9, y + 4, 1, 3);
      g.fillRect(x + 6, y + 4, 4, 1);
    }
  }

  private drawUnit(g: CanvasRenderingContext2D, u: UnitView, x: number, y: number, now: number) {
    const kind = UNIT_KINDS[u.kind] ?? 'z_small';
    if (kind.startsWith('r_')) return this.drawRaider(g, u, kind, x, y, now);
    const sh = ZOMBIE_SHEETS[kind]!;
    const s = this.sprites;
    let sheet: Sheet;
    let frame: number;
    if (u.state === 3) {
      // Rising: the death animation played backwards, climbing out of the grave.
      sheet = s[sh.death] as Sheet;
      const k = Math.min(1, (now - u.bornAt) / (CONFIG.waves.riseTime * 1000));
      frame = Math.max(0, sheet.frames - 1 - Math.floor(k * sheet.frames));
    } else if (u.state === 2) {
      sheet = s[sh.death] as Sheet;
      frame = Math.min(sheet.frames - 1, Math.floor((now - u.diedAt) / 90));
    } else if (u.state === 1) {
      sheet = s[sh.attack] as Sheet;
      frame = Math.floor(now / 110 + u.id);
    } else {
      sheet = s[sh.walk] as Sheet;
      frame = Math.floor(now / (120 / CONFIG.pace.zombieSpeed) + u.id); // legs keep up with the walking pace
    }
    g.fillStyle = 'rgba(0, 0, 0, 0.25)';
    g.fillRect(Math.round(x - 4), Math.round(y - 1), 8, 2);
    drawFrame(g, sheet, frame, x - sheet.fw / 2, y - sheet.fh + 1, u.facing < 0);
    if (u.state < 2 && u.hp < 100) this.hpBar(g, Math.round(x - 5), Math.round(y - sheet.fh - 2), 10, u.hp, '#e0573f');
  }

  private drawRaider(g: CanvasRenderingContext2D, u: UnitView, kind: string, x: number, y: number, now: number) {
    const look = RAIDER_LOOK[kind]!;
    g.fillStyle = 'rgba(0, 0, 0, 0.25)';
    g.fillRect(Math.round(x - 4), Math.round(y - 1), 8, 2);
    if (u.state === 2) {
      const d = this.sprites.bodyDeath;
      g.globalAlpha = 0.85;
      drawFrame(g, d, Math.min(d.frames - 1, Math.floor((now - u.diedAt) / 90)), x - d.fw / 2, y - d.fh, u.facing < 0);
      g.globalAlpha = 1;
      return;
    }
    const frame = Math.floor(now / (u.state === 0 ? 100 / CONFIG.pace.raiderSpeed : 100) + u.id) % 6;
    const img = this.survivor(look.weapon, look.helmet, frame, u.state === 0, 'rgba(200, 40, 40, 0.35)');
    const ox = Math.round(x - 14);
    const oy = Math.round(y - 19);
    if (u.facing < 0) {
      g.save();
      g.translate(ox + 28, oy);
      g.scale(-1, 1);
      g.drawImage(img, 0, 0);
      g.restore();
    } else g.drawImage(img, ox, oy);
    if (u.hp < 100) this.hpBar(g, Math.round(x - 5), Math.round(y - 20), 10, u.hp, '#e0573f');
  }

  private drawGraveWarning(g: CanvasRenderingContext2D, gx: number, gy: number, state: number, now: number) {
    const cx = (gx + 2.5) * T;
    const cy = gy * T - 6;
    const pulse = 0.6 + 0.4 * Math.sin(now / 150);
    g.fillStyle = state === 2 ? `rgba(224, 87, 63, ${pulse})` : `rgba(227, 179, 65, ${pulse})`;
    // A small skull-ish marker: rounded block with two eye holes.
    g.fillRect(cx - 4, cy - 6, 8, 6);
    g.fillRect(cx - 3, cy, 6, 2);
    g.fillStyle = '#1b1712';
    g.fillRect(cx - 3, cy - 4, 2, 2);
    g.fillRect(cx + 1, cy - 4, 2, 2);
  }

  private drawDeployZone(g: CanvasRenderingContext2D, p: WorldPlot, now: number) {
    const a = 0.18 + 0.08 * Math.sin(now / 250);
    g.fillStyle = `rgba(224, 87, 63, ${a})`;
    for (let y = 0; y < PLOT; y++) for (let x = 0; x < PLOT; x++) if (inDeployZone(x, y)) g.fillRect((p.x + x) * T, (p.y + y) * T, T, T);
    g.strokeStyle = 'rgba(255, 140, 120, 0.8)';
    g.lineWidth = 1;
    g.strokeRect(p.x * T + 0.5, p.y * T + 0.5, PLOT * T - 1, PLOT * T - 1);
    g.strokeRect((p.x + RING.x0) * T + 0.5, (p.y + RING.y0) * T + 0.5, (RING.x1 - RING.x0 + 1) * T - 1, (RING.y1 - RING.y0 + 1) * T - 1);
  }

  private drawPick(g: CanvasRenderingContext2D, p: WorldPlot, pick: BasePick, now: number) {
    const pulse = 0.55 + 0.35 * Math.sin(now / 180);
    g.strokeStyle = `rgba(255, 233, 150, ${pulse})`;
    g.lineWidth = 1;
    const ox = p.x * T;
    const oy = p.y * T;
    if (pick.kind === 'hq') g.strokeRect(ox + HQ_RECT.x * T - 3.5, oy + HQ_RECT.y * T - 10.5, HQ_RECT.w * T + 7, HQ_RECT.h * T + 14);
    else if (pick.kind === 'slot') {
      const s = SLOTS[pick.slot]!;
      g.strokeRect(ox + s.x * T - 1.5, oy + s.y * T - 10.5, T + 3, T + 12);
    } else g.strokeRect(ox + RING.x0 * T - 0.5, oy + RING.y0 * T - 0.5, (RING.x1 - RING.x0 + 1) * T + 1, (RING.y1 - RING.y0 + 1) * T + 1);
  }

  /** Name tag above a base: name, level, trophies, shield, under attack. Drawn in device pixels. */
  private drawTag(g: CanvasRenderingContext2D, p: WorldPlot, s: BaseSummary, now: number) {
    const img = this.tagImage(p, s);
    const [sx, sy] = this.toScreen((p.x + PLOT / 2) * T, (p.y + RING.y0) * T - 18);
    const x = Math.round(sx - img.width / 2);
    const y = Math.round(sy - img.height);
    if (s.raid) g.globalAlpha = 0.8 + 0.2 * Math.sin(now / 120);
    g.drawImage(img, x, y);
    g.globalAlpha = 1;
  }

  /** The tag as a small cached image: text is only rendered again when what it says changes. */
  private tagImage(p: WorldPlot, s: BaseSummary): HTMLCanvasElement {
    const d = this.dpr;
    const small = this.zoom < 2;
    const mine = p.id === this.myPlot;
    const shielded = Math.max(s.shield, s.immune) > Date.now() + this.clockSkew;
    const text = small ? s.name : `${s.name}  Lv${s.hq}  ♛${s.trophies}`;
    const key = `${text}|${mine}|${shielded}|${s.raid ? 1 : 0}|${small}|${d}`;
    const hit = this.tagCache.get(p.id);
    if (hit && hit.key === key) return hit.canvas;
    const fs = Math.round((small ? 10 : 12) * d);
    const font = `700 ${fs}px system-ui, sans-serif`;
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = font;
    const tw = Math.ceil(g.measureText(text).width);
    const padX = Math.round(5 * d);
    const extra = (shielded ? fs + 3 * d : 0) + (s.raid ? fs + 3 * d : 0);
    c.width = Math.ceil(tw + padX * 2 + extra);
    c.height = Math.ceil(fs + 6 * d);
    const h = c.height;
    g.fillStyle = mine ? 'rgba(227, 179, 65, 0.92)' : s.raid ? 'rgba(120, 30, 20, 0.9)' : 'rgba(27, 23, 18, 0.82)';
    g.fillRect(0, 0, c.width, h);
    g.font = font;
    g.fillStyle = mine ? '#1b1712' : '#f1e6cf';
    g.textBaseline = 'middle';
    g.fillText(text, padX, h / 2 + d);
    let ix = padX + tw + 3 * d;
    if (shielded) {
      const r = fs / 2;
      g.fillStyle = '#7fb2e5';
      g.beginPath();
      g.moveTo(ix, h / 2 - r);
      g.lineTo(ix + r * 2, h / 2 - r);
      g.lineTo(ix + r * 2, h / 2);
      g.quadraticCurveTo(ix + r * 2, h / 2 + r, ix + r, h / 2 + r * 1.2);
      g.quadraticCurveTo(ix, h / 2 + r, ix, h / 2);
      g.closePath();
      g.fill();
      ix += fs + 3 * d;
    }
    if (s.raid) {
      g.fillStyle = '#ff785a';
      g.fillText('⚔', ix, h / 2 + d);
    }
    this.tagCache.set(p.id, { key, canvas: c });
    return c;
  }

  private hpBar(g: CanvasRenderingContext2D, x: number, y: number, w: number, pct: number, color = '#8fc46b') {
    g.fillStyle = '#1b1712';
    g.fillRect(x - 1, y - 1, w + 2, 3);
    g.fillStyle = pct > 35 ? color : '#e0573f';
    g.fillRect(x, y, Math.max(1, Math.round((w * pct) / 100)), 1);
  }

  private tinyDigit(g: CanvasRenderingContext2D, n: number, x: number, y: number) {
    const D: Record<number, string> = { 1: '010110010111', 2: '111001111100', 3: '111011001111', 4: '101101111001', 5: '111110001110', 6: '100111101111', 7: '111001010010', 8: '111111101111' };
    const bits = D[n] ?? D[8]!;
    for (let i = 0; i < 12; i++) if (bits[i] === '1') g.fillRect(x + (i % 3), y + Math.floor(i / 3), 1, 1);
  }
}
