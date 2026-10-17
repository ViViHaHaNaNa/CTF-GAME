import {
  COMMANDER_WEAPONS,
  CONFIG,
  HQ_ID,
  HQ_RECT,
  PLOT,
  POST_TYPES,
  RING,
  SLOTS,
  UNIT_KINDS,
  ALLY_ID,
  VAULT_ID,
  VAULT_RECT,
  WALLS,
  ALLEY,
  PROP_FILES,
  getWorld,
  isAnimatedProp,
  commanderSpot,
  inDeployZone,
  killCoins,
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
  type ZombieKind,
} from '@siege/shared';
import { tinyText, tinyWidth } from './retro.ts';
import { COMMANDER_LAYERS, LAYER_OFFSET, drawFrame, type Facing, type Sheet, type Sprites } from './sprites.ts';
import { FONT, FONT_DISPLAY, THEME, baseColor, groundRule, recolour, textOn } from './theme.ts';

// Renders the shared world: a camera over one big pixel map at integer zoom (no smoothing).
// Ground + scenery are baked into chunks once (recoloured tiles, lane markings, soft shadows); distant
// bases are cached static sprites; only bases with a live stream (the ones this screen watches) get
// full animation. Ambient life (swaying grass, graveyard embers and fog, flags, rain) is drawn per
// frame for what's on screen only. Every colour comes from theme.ts. Pure rendering.
//
// Sieges put 100+ zombies on one base, so the unit path allocates nothing per frame: unit views are
// pooled, depth sorting uses one reused list, left-facing zombies use the pack's left sheets (no canvas
// transforms), and zoomed out they drop to a still frame with no shadow or health bar.

const T = 16;
const CHUNK = 32; // tiles per chunk side
const SNAP_MS = (1000 * CONFIG.snapshotEvery) / CONFIG.tickRate;
const world = getWorld();
const WPX = world.w * T;
const HPX = world.h * T;

/** Crossroads in the middle of the map, where global crates land (world px). */
export const CRATE_SPOT = { x: world.centre[0] * T, y: world.centre[1] * T + 8 };

export type BasePick = { kind: 'hq' } | { kind: 'walls' } | { kind: 'vault' } | { kind: 'slot'; slot: number };

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
  /** Ran in off the street (fades in) rather than climbing out of the ground. */
  walkIn: boolean;
}

/** Live action on one watched plot. */
export interface LiveState {
  /** 'wave' = a zombie siege is running there. */
  phase: 'calm' | 'wave' | 'raid';
  /** Siege state from the server: surge number, 'start' / 'surge' / 'breather'. */
  siege: { n: number; phase: string } | null;
  units: Map<number, UnitView>;
  hp: Map<number, number>;
  tracers: { x0: number; y0: number; x1: number; y1: number; at: number }[];
  puffs: { x: number; y: number; at: number }[];
  /** Cracks in the ground that zombies climbed out of. */
  cracks: { x: number; y: number; at: number; v: number }[];
  /** Manholes (index into world.manholes) with their lids pushed aside, until this local ms. */
  manholes: Map<number, number>;
  /** "+1" coin pops over kills (own base only). */
  pops: { x: number; y: number; at: number; img: HTMLCanvasElement }[];
  postFacing: Map<number, number>;
  lastShot: Map<number, number>;
  lastSnapAt: number;
  raid: RaidStatus | null;
  /** The Commander: which way they face and when they last fired (local ms). */
  cmd: { face: Facing; shotAt: number };
  /** Commander tracers (brighter and longer-lived than the posts'). */
  shots: { x0: number; y0: number; x1: number; y1: number; at: number }[];
  /** Short-lived tap effects: 0 hit spark, 1 damage number, 2 kill hit-marker, 3 ejected casing. */
  fx: { kind: number; x: number; y: number; vx: number; vy: number; at: number; img: HTMLCanvasElement | null; w: number }[];
  /** Airstrikes: the warning marker until `land`, then the blast. */
  strikes: { x: number; y: number; r: number; at: number; land: number }[];
  /** Molotov fires (world px), burning until `until` (local ms). */
  fires: { x: number; y: number; r: number; at: number; until: number }[];
}

type ZombieSheets = { walk: keyof Sprites; attack: keyof Sprites; death: keyof Sprites };
/** Right-facing and left-facing sheets per zombie kind. */
const ZOMBIE_SHEETS: Record<string, [ZombieSheets, ZombieSheets]> = {
  z_small: [{ walk: 'zSmallWalk', attack: 'zSmallAttack', death: 'zSmallDeath' }, { walk: 'zSmallWalkL', attack: 'zSmallAttackL', death: 'zSmallDeathL' }],
  z_big: [{ walk: 'zBigWalk', attack: 'zBigAttack', death: 'zBigDeath' }, { walk: 'zBigWalkL', attack: 'zBigAttackL', death: 'zBigDeathL' }],
  z_axe: [{ walk: 'zAxeWalk', attack: 'zAxeAttack', death: 'zAxeDeath' }, { walk: 'zAxeWalkL', attack: 'zAxeAttackL', death: 'zAxeDeathL' }],
  z_boss: [{ walk: 'zBigWalk', attack: 'zBigAttack', death: 'zBigDeath' }, { walk: 'zBigWalkL', attack: 'zBigAttackL', death: 'zBigDeathL' }],
};
/** Zoomed out further than this (device px per art px), units drop to a still frame without shadow or health bar. */
const LOD_K = 1.75;
const CRACK_MS = 3500;
const POP_MS = 750;
const MANHOLE_MS = 1400;
const SHOT_MS = 110;
const BOOM_MS = 650;

/** One depth-sorted thing to draw on a base (records are reused frame to frame). */
interface DrawItem {
  y: number;
  /** 0 wall, 1 Main Tower, 2 post, 3 empty slot, 4 unit, 5 Commander, 6 vault */
  kind: number;
  i: number;
  unit: UnitView | null;
}

/** Raider looks: body + weapon (+ helmet), tinted red so they never read as defenders. */
const RAIDER_LOOK: Record<string, { weapon: 'bat' | 'pistol' | 'shotgun'; helmet: boolean }> = {
  r_bat: { weapon: 'bat', helmet: false },
  r_pistol: { weapon: 'pistol', helmet: false },
  r_helmet: { weapon: 'bat', helmet: true },
  r_shotgun: { weapon: 'shotgun', helmet: false },
};

/** 0..1 how hard it's raining at wall-clock time `ms`: a short shower every few minutes, the same on every screen. */
export function rainAmount(ms: number): number {
  const w = THEME.weather;
  const t = (ms / 1000) % w.every;
  if (t > w.lasts) return 0;
  return Math.max(0, Math.min(1, t / w.fade, (w.lasts - t) / w.fade));
}

function hash(x: number, y: number, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Plot-level base description, from the world summary (or the player's own fresher state). */
function baseOf(s: BaseSummary): BaseState {
  return { hq: s.hq, walls: s.walls, posts: s.posts.map((p) => (p ? { type: POST_TYPES[p[0]]!, level: p[1] } : null)), cmd: s.cmd ?? 0 };
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
  /** The ground tileset recoloured for each kind of ground (palette remap at load time). */
  private tiles: Record<'grass' | 'earth', HTMLCanvasElement>;
  /** Asphalt texture variants (generated, so streets never show a tiling pattern). */
  private asphalt: HTMLCanvasElement[] = [];
  /** Grass tufts that sway: drawn each frame (when on screen) instead of baked. */
  private swayers: { img: HTMLImageElement; x: number; y: number; seed: number }[] = [];
  /** Pre-rendered effect sprites, so animating them each frame allocates nothing. */
  private flagCache = new Map<number, HTMLCanvasElement[]>();
  private blob = { shadow: null as HTMLCanvasElement | null, fog: null as HTMLCanvasElement | null };
  private emberStyle = { glow: '', core: '' };
  /** Where puddles form when it rains (world px). */
  private puddles: { x: number; y: number; r: number; seed: number }[] = [];
  private numberCache = new Map<string, HTMLCanvasElement>();
  /** Unit views and draw records, reused so busy sieges allocate nothing per frame. */
  private unitPool: UnitView[] = [];
  private drawList: DrawItem[] = [];
  private seenUnits = new Set<number>();
  private popCache = new Map<number, HTMLCanvasElement>();
  private crackCache: HTMLCanvasElement[] = [];
  private yard: HTMLCanvasElement | null = null;
  /** Screen shake: strength in device px, decaying until `shakeUntil`. */
  private shakeAmp = 0;
  private shakeFrom = 0;
  private shakeUntil = 0;
  /** Where the zombies are pressing hardest on your own base (north, east, south, west), from the server. */
  pressure: { sides: number[]; at: number } | null = null;
  /** Sides the next surge on your base comes from (0-3, 4 = graveyard), shown as arrows while set. */
  incoming: number[] = [];
  /** Your current surge's toughness (kill coins scale with it). */
  myToughness = 1;
  /** Told when your own Main Tower loses health (for the red vignette). */
  onHqHurt: ((hp: number, drop: number) => void) | null = null;
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
    const src = sprites.ground.img;
    this.tiles = { grass: recolour(src, groundRule('grass')), earth: recolour(src, groundRule('earth')) };
    const A = THEME.asphalt;
    for (let v = 0; v < 4; v++) {
      const c = document.createElement('canvas');
      c.width = T;
      c.height = T;
      const g = c.getContext('2d')!;
      g.fillStyle = A.base;
      g.fillRect(0, 0, T, T);
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          const r = hash(x, y, 40 + v);
          if (r < A.lightShare) g.fillStyle = A.light;
          else if (r < A.lightShare + A.darkShare) g.fillStyle = A.dark;
          else continue;
          g.fillRect(x, y, 1, 1);
        }
      this.asphalt.push(c);
    }
    for (const pr of world.props) if (isAnimatedProp(PROP_FILES[pr.f]!)) this.swayers.push({ img: sprites.props[pr.f]!, x: pr.x, y: pr.y, seed: hash(pr.x, pr.y, 5) });
    for (let i = 0; i < 2000 && this.puddles.length < 160; i++) {
      const tx = Math.floor(hash(i, 1, 77) * world.w);
      const ty = Math.floor(hash(i, 2, 77) * world.h);
      const gk = world.ground[ty * world.w + tx];
      if (gk === 1 || gk === 3 || (gk === 0 && hash(i, 4, 77) < 0.3)) this.puddles.push({ x: (tx + hash(i, 3, 77)) * T, y: (ty + hash(i, 5, 77)) * T, r: 4 + hash(i, 6, 77) * 7, seed: hash(i, 7, 77) });
    }
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
    if (tx >= VAULT_RECT.x && tx < VAULT_RECT.x + VAULT_RECT.w && ty >= VAULT_RECT.y - 1 && ty < VAULT_RECT.y + VAULT_RECT.h) return { kind: 'vault' };
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
      l = { phase: 'calm', siege: null, units: new Map(), hp: new Map(), tracers: [], puffs: [], cracks: [], manholes: new Map(), pops: [], postFacing: new Map(), lastShot: new Map(), lastSnapAt: 0, raid: null, cmd: { face: 'down', shotAt: -1e9 }, shots: [], fx: [], strikes: [], fires: [] };
      this.live.set(plot, l);
    }
    return l;
  }

  resetCombat(plot: number) {
    const l = this.liveFor(plot);
    for (const u of l.units.values()) this.unitPool.push(u);
    l.units.clear();
    l.hp.clear();
    l.tracers = [];
    l.puffs = [];
    l.cracks = [];
    l.manholes.clear();
    l.pops = [];
  }

  /** Stop drawing a plot's live action (it scrolled out of view). */
  dropLive(plot: number) {
    const l = this.live.get(plot);
    if (!l) return;
    for (const u of l.units.values()) this.unitPool.push(u);
    this.live.delete(plot);
  }

  /** Shake the screen for `ms` with `amp` device pixels at the start. */
  shake(amp: number, ms: number) {
    const now = performance.now();
    if (amp * Math.max(0, 1 - (now - this.shakeFrom) / Math.max(1, this.shakeUntil - this.shakeFrom)) > amp) return;
    this.shakeAmp = amp;
    this.shakeFrom = now;
    this.shakeUntil = now + ms;
  }

  applySnapshot(plot: number, s: Snapshot, now: number) {
    const l = this.liveFor(plot);
    const seen = this.seenUnits;
    seen.clear();
    const mine = plot === this.myPlot;
    const p = world.plots[plot]!;
    for (const [id, kind, x, y, hp, state, facing] of s.u) {
      seen.add(id);
      const u = l.units.get(id);
      if (u) {
        u.px = u.x;
        u.py = u.y;
        u.x = x;
        u.y = y;
        u.hp = hp;
        if (state === 2 && u.state !== 2) {
          u.diedAt = now;
          // Every kill on your own base pops its coins right where it fell.
          const k = UNIT_KINDS[kind];
          if (mine && this.myBase && k?.startsWith('z_')) l.pops.push({ x, y: y - 14, at: now, img: this.popImage(killCoins(k as ZombieKind, this.myToughness)) });
        }
        u.state = state;
        u.facing = facing;
      } else {
        const v = this.unitPool.pop() ?? ({} as UnitView);
        v.id = id;
        v.kind = kind;
        v.px = v.x = x;
        v.py = v.y = y;
        v.hp = hp;
        v.state = state;
        v.facing = facing;
        v.diedAt = state === 2 ? now : 0;
        v.bornAt = now;
        // Appearing outside the plot without climbing out = ran in off the street.
        v.walkIn = state !== 3 && (x < p.x * T || y < p.y * T || x >= (p.x + PLOT) * T || y >= (p.y + PLOT) * T);
        l.units.set(id, v);
        if (state === 3) this.risingFx(l, plot, x, y, now);
      }
    }
    for (const [id, u] of l.units) {
      if (seen.has(id)) continue;
      this.unitPool.push(u);
      l.units.delete(id);
    }
    for (const [id, hp] of s.b) {
      if (mine && id === HQ_ID && this.onHqHurt) {
        const before = l.hp.get(id) ?? 100;
        if (hp < before) this.onHqHurt(hp, before - hp);
      }
      l.hp.set(id, hp);
    }
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

  // ---- the Commander ---------------------------------------------------------------------------------

  /** Where the Commander stands (world px, feet) and the weapon they hold on this plot. */
  private commander(plot: number): { x: number; y: number; weapon: 'pistol' | 'gun' | 'shotgun' } {
    const p = world.plots[plot]!;
    const [fx, fy] = commanderSpot(p);
    const base = plot === this.myPlot && this.myBase ? this.myBase : this.bases.get(plot);
    return { x: fx * T, y: fy * T, weapon: COMMANDER_WEAPONS[base?.cmd ?? 0] ?? 'pistol' };
  }

  /** Which way to face to shoot from (x, y) at (tx, ty). */
  private faceToward(x: number, y: number, tx: number, ty: number): Facing {
    const dx = tx - x;
    const dy = ty - y;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
  }

  /** The Commander's body and weapon sheets for a facing. */
  private commanderSheets(weapon: 'pistol' | 'gun' | 'shotgun', face: Facing): { body: Sheet; gun: Sheet; fire: Sheet } {
    const s = this.sprites;
    const W = { pistol: ['pistol', 'pistolDown', 'pistolUp', 'pistolLeft'], gun: ['gun', 'gunDown', 'gunUp', 'gunLeft'], shotgun: ['shotgun', 'shotgunDown', 'shotgunUp', 'shotgunLeft'] } as const;
    const i = face === 'right' ? 0 : face === 'down' ? 1 : face === 'up' ? 2 : 3;
    const body = [s.body, s.bodyDown, s.bodyUp, s.bodyLeft][i]!;
    const fire = [s.fire, s.fireDown, s.fireUp, s.fireLeft][i]!;
    return { body, gun: s[W[weapon][i]] as Sheet, fire };
  }

  /** Top-left of the muzzle flash sprite, relative to the body's top-left. */
  private muzzleOffset(weapon: 'pistol' | 'gun' | 'shotgun', face: Facing, gun: Sheet, fire: Sheet): [number, number] {
    const o = COMMANDER_LAYERS[weapon][face];
    const f = LAYER_OFFSET.fire[weapon];
    if (face === 'right') return [o.x + f.x, o.y + f.y];
    if (face === 'left') return [o.x + gun.fw - f.x - fire.fw, o.y + f.y];
    if (face === 'down') return [o.x + Math.floor(gun.fw / 2) - Math.floor(fire.fw / 2), o.y + gun.fh - 2];
    return [o.x + Math.floor(gun.fw / 2) - Math.floor(fire.fw / 2), o.y - fire.fh + 2];
  }

  /** World px the Commander's shots leave from when facing `face`. */
  private muzzle(plot: number, face: Facing): [number, number] {
    const c = this.commander(plot);
    const { body, gun, fire } = this.commanderSheets(c.weapon, face);
    const [mx, my] = this.muzzleOffset(c.weapon, face, gun, fire);
    return [Math.round(c.x - body.fw / 2) + mx + fire.fw / 2, c.y - body.fh + my + fire.fh / 2];
  }

  private drawCommander(g: CanvasRenderingContext2D, plot: number, base: BaseState, l: LiveState | null, now: number, ox = 0, oy = 0) {
    const p = world.plots[plot]!;
    const [fx, fy] = commanderSpot(p);
    // `ox/oy` re-base a cached static image (drawn at a different origin).
    const x = fx * T + ox;
    const y = fy * T + oy;
    const weapon = COMMANDER_WEAPONS[base.cmd ?? 0] ?? 'pistol';
    const face = l?.cmd.face ?? 'down';
    const { body, gun, fire } = this.commanderSheets(weapon, face);
    const since = l ? now - l.cmd.shotAt : 1e9;
    // A pixel of recoil while firing.
    const kick = since < 70 ? 1 : 0;
    const kx = face === 'right' ? -kick : face === 'left' ? kick : 0;
    const ky = face === 'down' ? -kick : face === 'up' ? kick : 0;
    const bx = Math.round(x - body.fw / 2) + kx;
    const by = y - body.fh + ky;
    const frame = l ? Math.floor(now / 170) : 0;
    g.fillStyle = THEME.unitShadow;
    g.fillRect(Math.round(x - 5), y - 1, 10, 2);
    const o = COMMANDER_LAYERS[weapon][face];
    if (face === 'up') drawFrame(g, gun, frame, bx + o.x, by + o.y);
    drawFrame(g, body, frame, bx, by);
    if (face !== 'up') drawFrame(g, gun, frame, bx + o.x, by + o.y);
    if (since < SHOT_MS * 0.7) {
      const [mx, my] = this.muzzleOffset(weapon, face, gun, fire);
      drawFrame(g, fire, Math.floor(since / 25), bx + mx, by + my);
    }
  }

  /**
   * The Commander fires at (tx, ty) world px: turn, flash, tracer, a casing. Called at once for your own
   * taps (prediction) and when a watched base's tap result arrives.
   */
  commanderFire(plot: number, tx: number, ty: number, now: number, pellets: [number, number][] = []) {
    const l = this.liveFor(plot);
    const c = this.commander(plot);
    l.cmd.face = this.faceToward(c.x, c.y - 8, tx, ty);
    l.cmd.shotAt = now;
    const [mx, my] = this.muzzle(plot, l.cmd.face);
    for (const [px, py] of pellets.length ? pellets : [[tx, ty] as [number, number]]) l.shots.push({ x0: mx, y0: my, x1: px, y1: py - 6, at: now });
    const side = l.cmd.face === 'left' ? 1 : -1;
    const img = (c.weapon === 'shotgun' ? this.sprites.casingShotgun : c.weapon === 'gun' ? this.sprites.casingGun : this.sprites.casingPistol).img;
    l.fx.push({ kind: 3, x: c.x, y: c.y - 9, vx: side * (0.03 + Math.random() * 0.03), vy: -0.09 - Math.random() * 0.04, at: now, img: img as unknown as HTMLCanvasElement, w: 0 });
  }

  /** Live zombies on a plot nearest (x, y) world px within r, closest first (client-side aim prediction). */
  zombiesNear(plot: number, x: number, y: number, r: number, max = 1): { x: number; y: number }[] {
    const l = this.live.get(plot);
    if (!l) return [];
    const out: { x: number; y: number; d: number }[] = [];
    for (const u of l.units.values()) {
      if (u.state >= 2 || !UNIT_KINDS[u.kind]?.startsWith('z_')) continue;
      const d = Math.hypot(u.x - x, u.y - y);
      if (d <= r) out.push({ x: u.x, y: u.y, d });
    }
    return out.sort((a, b) => a.d - b.d).slice(0, max);
  }

  /** Server-confirmed hits (world px): damage numbers, sparks, and a hit-marker on kills. */
  tapHits(plot: number, hits: [number, number, number, number][], now: number) {
    const l = this.liveFor(plot);
    for (const [x, y, dmg, killed] of hits) {
      l.fx.push({ kind: 0, x, y: y - 7, vx: 0, vy: 0, at: now, img: null, w: 0 });
      l.fx.push({ kind: 1, x: x + (Math.random() - 0.5) * 6, y: y - 16, vx: 0, vy: 0, at: now, img: this.numberImage(dmg, !!killed), w: 0 });
      if (killed) l.fx.push({ kind: 2, x, y: y - 7, vx: 0, vy: 0, at: now, img: null, w: 0 });
    }
  }

  /** An airstrike called on a spot (world px): warning marker until it lands. */
  airstrikeWarn(plot: number, x: number, y: number, r: number, delayMs: number, now: number) {
    this.liveFor(plot).strikes.push({ x, y, r, at: now, land: now + delayMs });
  }

  /** A molotov burst into flames at (x, y) world px. */
  molotov(plot: number, x: number, y: number, r: number, ms: number, now: number) {
    this.liveFor(plot).fires.push({ x, y, r, at: now, until: now + ms });
  }

  /** Your squad member's unit (if out) on a plot, world px. */
  squadAt(plot: number): { x: number; y: number } | null {
    const u = this.live.get(plot)?.units.get(ALLY_ID);
    return u && u.state < 2 ? { x: u.x, y: u.y } : null;
  }

  /** Where you last sent your squad member (world px), shown as a flag for a moment. */
  squadFlag: { plot: number; x: number; y: number; at: number } | null = null;

  /** The strike landed (server): blast now, even if the warning drifted. */
  airstrikeLand(plot: number, x: number, y: number, now: number) {
    const l = this.liveFor(plot);
    const s = l.strikes.find((k) => Math.hypot(k.x - x, k.y - y) < 4 && k.land + BOOM_MS > now);
    if (s) s.land = Math.min(s.land, now);
    else l.strikes.push({ x, y, r: CONFIG.commander.airstrike.radius * T, at: now, land: now });
  }

  /** A damage number: white, red when it killed; dark outline, 3x5 pixel font. Cached per value. */
  private numberImage(n: number, kill: boolean): HTMLCanvasElement {
    const key = `${n}${kill ? 'k' : ''}`;
    let c = this.numberCache.get(key);
    if (c) return c;
    const text = String(n);
    c = document.createElement('canvas');
    c.width = tinyWidth(text) + 2;
    c.height = 7;
    const g = c.getContext('2d')!;
    for (const [dx, dy] of [[0, 1], [2, 1], [1, 0], [1, 2], [2, 2]]) tinyText(g, text, dx!, dy!, THEME.siege.coinOutline);
    tinyText(g, text, 1, 1, kill ? THEME.cmd.kill : THEME.cmd.damage);
    this.numberCache.set(key, c);
    return c;
  }

  /** Tracers, sparks, numbers, hit-markers, casings and airstrikes (drawn over the units). */
  private drawTapFx(g: CanvasRenderingContext2D, l: LiveState, now: number) {
    if (l.shots.length) {
      let keep = 0;
      for (const t of l.shots) {
        const k = (now - t.at) / SHOT_MS;
        if (k >= 1) continue;
        l.shots[keep++] = t;
        g.globalAlpha = 1 - k;
        g.strokeStyle = THEME.cmd.tracerGlow;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(t.x0, t.y0);
        g.lineTo(t.x1, t.y1);
        g.stroke();
        g.strokeStyle = THEME.cmd.tracer;
        g.lineWidth = 1;
        g.stroke();
      }
      l.shots.length = keep;
      g.globalAlpha = 1;
    }
    if (l.fx.length) {
      let keep = 0;
      for (const f of l.fx) {
        const age = now - f.at;
        const life = f.kind === 0 ? 180 : f.kind === 1 ? 700 : f.kind === 2 ? 200 : 600;
        if (age >= life) continue;
        l.fx[keep++] = f;
        const k = age / life;
        if (f.kind === 0) {
          // Spark: four bright pixels flying apart.
          g.fillStyle = THEME.cmd.spark;
          const r = 1 + k * 5;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0.6, -0.8], [-0.6, -0.8]] as const) g.fillRect(Math.round(f.x + dx * r), Math.round(f.y + dy * r), 1, 1);
        } else if (f.kind === 1) {
          g.globalAlpha = k < 0.6 ? 1 : (1 - k) / 0.4;
          g.drawImage(f.img!, Math.round(f.x - f.img!.width / 2), Math.round(f.y - 12 * Math.sqrt(k)));
          g.globalAlpha = 1;
        } else if (f.kind === 2) {
          // Hit-marker: a white X that flashes on a kill.
          g.fillStyle = THEME.cmd.marker;
          const x = Math.round(f.x);
          const y = Math.round(f.y);
          for (let i = 2; i <= 4; i++) {
            g.fillRect(x - i, y - i, 1, 1);
            g.fillRect(x + i, y - i, 1, 1);
            g.fillRect(x - i, y + i, 1, 1);
            g.fillRect(x + i, y + i, 1, 1);
          }
        } else {
          // Casing: hops out, falls back, bounces, fades.
          const t = Math.min(age, 380);
          const x = f.x + f.vx * t;
          const y = f.y + f.vy * t + 0.0006 * t * t;
          g.globalAlpha = 1 - k * k;
          g.drawImage(f.img!, Math.round(x), Math.round(Math.min(y, f.y + 8)));
          g.globalAlpha = 1;
        }
      }
      l.fx.length = keep;
    }
    if (l.fires.length) {
      let keep = 0;
      for (const f of l.fires) {
        if (now > f.until) continue;
        l.fires[keep++] = f;
        // Scorched ground, then flickering pixel flames that die down at the end.
        const fade = Math.min(1, (f.until - now) / 600, (now - f.at) / 150);
        g.globalAlpha = 0.35 * fade;
        g.fillStyle = `rgb(${THEME.cmd.smoke.join(', ')})`;
        g.beginPath();
        g.ellipse(f.x, f.y, f.r, f.r * 0.6, 0, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = fade;
        for (let i = 0; i < 26; i++) {
          const a = hash(i, f.x, 7) * Math.PI * 2;
          const d = Math.sqrt(hash(i, f.y, 8)) * f.r * 0.9;
          const x = Math.round(f.x + Math.cos(a) * d);
          const y = Math.round(f.y + Math.sin(a) * d * 0.6);
          const h = 3 + Math.round(4 * (0.5 + 0.5 * Math.sin(now / 90 + i * 1.7)));
          g.fillStyle = `rgb(${THEME.cmd.strike.join(', ')})`;
          g.fillRect(x - 1, y - h, 3, h);
          g.fillStyle = `rgb(${THEME.cmd.fire.join(', ')})`;
          g.fillRect(x, y - h + 1, 1, h - 2);
        }
        g.globalAlpha = 1;
      }
      l.fires.length = keep;
    }
    // Your squad member: a ring at their feet, and a flag where you sent them.
    const ally = l.units.get(ALLY_ID);
    if (ally && ally.state < 2) {
      g.strokeStyle = `rgb(${THEME.cmd.squad.join(', ')})`;
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(ally.x, ally.y, 7, 3.5, 0, 0, Math.PI * 2);
      g.stroke();
    }
    const flag = this.squadFlag;
    if (flag && l === this.live.get(flag.plot) && now - flag.at < 1500) {
      g.globalAlpha = 1 - (now - flag.at) / 1500;
      g.fillStyle = `rgb(${THEME.cmd.squad.join(', ')})`;
      g.fillRect(Math.round(flag.x), Math.round(flag.y) - 10, 1, 10);
      g.fillRect(Math.round(flag.x) + 1, Math.round(flag.y) - 10, 5, 3);
      g.globalAlpha = 1;
    }
    if (l.strikes.length) {
      let keep = 0;
      for (const s of l.strikes) {
        if (now > s.land + BOOM_MS) continue;
        l.strikes[keep++] = s;
        if (now < s.land) {
          // Warning: a pulsing ring that closes in, and a crosshair.
          const k = Math.min(1, (now - s.at) / Math.max(1, s.land - s.at));
          const pulse = 0.5 + 0.5 * Math.sin(now / 70);
          g.strokeStyle = `rgba(${THEME.cmd.strike.join(', ')}, ${0.5 + 0.4 * pulse})`;
          g.lineWidth = 1;
          g.beginPath();
          g.ellipse(s.x, s.y, s.r, s.r * 0.6, 0, 0, Math.PI * 2);
          g.stroke();
          g.fillStyle = `rgba(${THEME.cmd.strike.join(', ')}, ${0.12 + 0.18 * k})`;
          g.beginPath();
          g.ellipse(s.x, s.y, s.r * k, s.r * 0.6 * k, 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = `rgb(${THEME.cmd.strike.join(', ')})`;
          g.fillRect(Math.round(s.x) - 6, Math.round(s.y), 13, 1);
          g.fillRect(Math.round(s.x), Math.round(s.y) - 4, 1, 9);
        } else {
          // Blast: a white flash, an orange fireball, a smoke ring spreading out.
          const k = (now - s.land) / BOOM_MS;
          g.globalAlpha = 1 - k;
          g.fillStyle = `rgba(${THEME.cmd.smoke.join(', ')}, 0.6)`;
          g.beginPath();
          g.ellipse(s.x, s.y, s.r * (0.6 + 0.6 * k), s.r * 0.6 * (0.6 + 0.6 * k), 0, 0, Math.PI * 2);
          g.fill();
          // Fireball: red rim, orange body, a hot yellow-white core that shrinks first.
          const f = 1 - k * 0.6;
          g.fillStyle = `rgb(${THEME.cmd.strike.join(', ')})`;
          g.beginPath();
          g.ellipse(s.x, s.y - 4 * k, s.r * 0.75 * f, s.r * 0.5 * f, 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = `rgb(${THEME.cmd.fire.join(', ')})`;
          g.beginPath();
          g.ellipse(s.x, s.y - 5 * k, s.r * 0.58 * f, s.r * 0.38 * f, 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = THEME.cmd.flash;
          g.beginPath();
          g.ellipse(s.x, s.y - 6 * k, s.r * 0.32 * (1 - k), s.r * 0.2 * (1 - k), 0, 0, Math.PI * 2);
          g.fill();
          // Debris flung out in an arc.
          g.fillStyle = `rgb(${THEME.cmd.smoke.join(', ')})`;
          for (let i = 0; i < 14; i++) {
            const a = (i / 14) * Math.PI * 2 + hash(i, s.x, 3);
            const d = s.r * (0.3 + 1.1 * k) * (0.6 + 0.4 * hash(i, s.y, 4));
            g.fillRect(Math.round(s.x + Math.cos(a) * d), Math.round(s.y + Math.sin(a) * d * 0.6 - 18 * k * (1 - k) * 4), 2, 2);
          }
          if (k < 0.25) {
            g.fillStyle = THEME.cmd.flash;
            g.globalAlpha = 1 - k * 4;
            g.beginPath();
            g.ellipse(s.x, s.y, s.r * 0.5, s.r * 0.32, 0, 0, Math.PI * 2);
            g.fill();
          }
          g.globalAlpha = 1;
        }
      }
      l.strikes.length = keep;
    }
  }

  /** A zombie starts climbing out: from a grave (dirt puff), its manhole (lid pushed aside) or a fresh crack. */
  private risingFx(l: LiveState, plot: number, x: number, y: number, now: number) {
    l.puffs.push({ x, y, at: now });
    const tx = x / T;
    const ty = y / T;
    const gy = world.graveyards[world.plots[plot]!.graveyard]!;
    if (gy.graves.some((g) => Math.abs(g.x + 0.5 - tx) < 0.6 && Math.abs(g.y + 0.85 - ty) < 0.6)) return;
    const m = world.manholes.findIndex((h) => h.plot === plot && Math.abs(h.x + 0.5 - tx) < 0.6 && Math.abs(h.y + 0.6 - ty) < 0.6);
    if (m >= 0) l.manholes.set(m, now + MANHOLE_MS);
    else l.cracks.push({ x, y, at: now, v: Math.floor(hash(x, y, 3) * 3) });
  }

  /** "+N" in the 3x5 pixel font with a dark outline, cached per value. */
  private popImage(n: number): HTMLCanvasElement {
    let c = this.popCache.get(n);
    if (c) return c;
    const text = `+${n}`;
    c = document.createElement('canvas');
    c.width = tinyWidth(text) + 2;
    c.height = 7;
    const g = c.getContext('2d')!;
    for (const [dx, dy] of [[0, 1], [2, 1], [1, 0], [1, 2], [2, 2]]) tinyText(g, text, dx!, dy!, THEME.siege.coinOutline);
    tinyText(g, text, 1, 1, THEME.siege.coin);
    this.popCache.set(n, c);
    return c;
  }

  /** A jagged crack in the ground (3 variants, drawn once). */
  private crackImage(v: number): HTMLCanvasElement {
    if (this.crackCache[v]) return this.crackCache[v]!;
    const c = document.createElement('canvas');
    c.width = 20;
    c.height = 10;
    const g = c.getContext('2d')!;
    const glow = `rgb(${THEME.siege.crackGlow.join(', ')})`;
    // A dark hole in the middle with a few branching fissures; a hint of glow inside.
    g.fillStyle = THEME.siege.crack;
    g.fillRect(7, 4, 6, 3);
    g.fillRect(8, 3, 4, 5);
    for (let arm = 0; arm < 4; arm++) {
      let x = 10;
      let y = 5;
      const dx = arm % 2 ? 1 : -1;
      for (let i = 0; i < 6; i++) {
        x += dx;
        y += hash(v, arm * 10 + i, 21) < 0.33 ? -1 : hash(v, arm * 10 + i, 22) < 0.5 ? 1 : 0;
        if (x < 0 || x >= 20 || y < 0 || y >= 10) break;
        g.fillRect(x, y, 1, 1);
      }
    }
    g.fillStyle = glow;
    g.fillRect(9, 5, 2, 1);
    this.crackCache[v] = c;
    return c;
  }

  // ---- drawing ------------------------------------------------------------------------------------

  draw(now: number) {
    const g = this.g;
    const c = this.cam;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = THEME.void;
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    let ox = Math.round(this.canvas.width / 2 - c.x * c.k);
    let oy = Math.round(this.canvas.height / 2 - c.y * c.k);
    if (now < this.shakeUntil) {
      const a = this.shakeAmp * ((this.shakeUntil - now) / (this.shakeUntil - this.shakeFrom));
      ox += Math.round(Math.sin(now * 0.091) * a);
      oy += Math.round(Math.cos(now * 0.077) * a);
    }
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
    this.drawSwayingGrass(g, x0, y0, x1, y1, now);

    // 2. Bases and ruins in view.
    const visible = world.plots.filter((p) => (p.x + PLOT) * T > x0 - 16 && p.x * T < x1 && (p.y + PLOT) * T + 16 > y0 && p.y * T - 24 < y1);
    for (const p of visible) {
      const s = this.bases.get(p.id);
      if (!s) {
        g.drawImage(this.ruins(p.id), p.x * T, p.y * T - 8);
        continue;
      }
      const l = this.live.get(p.id);
      const detailed = !!l && (l.phase !== 'calm' || l.units.size > 0 || p.id === this.myPlot);
      const base = p.id === this.myPlot && this.myBase ? this.myBase : baseOf(s);
      if (detailed) this.drawBaseLive(g, p, base, l!, now);
      else g.drawImage(this.staticBase(p.id, base), p.x * T, p.y * T - 16);
    }
    for (const p of visible) {
      const s = this.bases.get(p.id);
      if (s) this.drawFlag(g, p, s.id, now);
    }
    const wet = rainAmount(Date.now() + this.clockSkew);
    if (wet > 0) this.drawRainGround(g, x0, y0, x1, y1, wet, now);

    // 3. Graveyard warnings and deploy zone.
    for (const gy of world.graveyards) {
      if ((gy.x + 8) * T < x0 || (gy.x - 2) * T > x1 || (gy.y + 8) * T < y0 || (gy.y - 4) * T > y1) continue;
      const state = Math.max(0, ...gy.serves.map((id) => this.bases.get(id)?.wave ?? 0));
      this.drawGraveyardFx(g, gy.id, (gy.x + gy.w / 2) * T, (gy.y + gy.h / 2) * T, state, now);
      // The skull marker only flags a siege about to start: once it's on, the zombies speak for themselves.
      if (state === 1) this.drawGraveWarning(g, gy.x, gy.y, state, now);
    }
    if (this.deployPlot >= 0) this.drawDeployZone(g, world.plots[this.deployPlot]!, now);
    if (this.selectedPlot >= 0 && this.selectedPick && this.selectedPlot === this.myPlot) this.drawPick(g, world.plots[this.myPlot]!, this.selectedPick, now);
    if (this.crate) this.drawCrate(g, this.crate.rarity, now);

    // 4. Screen space: rain, then labels (crisp text at any zoom).
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (wet > 0) this.drawRainAir(g, wet, now);
    for (const p of visible) {
      const s = this.bases.get(p.id);
      if (s) this.drawTag(g, p, s, now);
    }
    if (this.crate) this.drawCrateTag(this.crate.rarity);
    this.drawPressureArrow(g, now);
  }

  /** A screen-edge arrow toward side `side` of your base (or toward its graveyard), `rgb` colour. */
  private edgeArrow(g: CanvasRenderingContext2D, side: number, rgb: readonly number[], size: number, alpha: number) {
    const d = this.dpr;
    const p = world.plots[this.myPlot]!;
    const [bx, by] = this.toScreen((p.x + PLOT / 2) * T, (p.y + PLOT / 2) * T);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const m = 34 * d;
    const top = 64 * d;
    let ang: number;
    let x: number;
    let y: number;
    if (side === 4) {
      // The graveyard sits at a corner: point from the base toward it, from the screen edge that way.
      const gy = world.graveyards[p.graveyard]!;
      const [gx, gyy] = this.toScreen((gy.x + gy.w / 2) * T, (gy.y + gy.h / 2) * T);
      ang = Math.atan2(gyy - by, gx - bx);
      x = Math.max(m, Math.min(W - m, bx + Math.cos(ang) * W));
      y = Math.max(top, Math.min(H - m, by + Math.sin(ang) * H));
    } else {
      ang = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][side]!;
      x = side === 1 ? W - m : side === 3 ? m : Math.max(m, Math.min(W - m, bx));
      y = side === 0 ? top : side === 2 ? H - m : Math.max(top, Math.min(H - m, by));
    }
    g.save();
    g.translate(Math.round(x), Math.round(y));
    g.rotate(ang);
    g.globalAlpha = alpha;
    g.fillStyle = `rgb(${rgb.join(', ')})`;
    g.strokeStyle = THEME.siege.arrowOutline;
    g.lineWidth = 2 * d;
    g.beginPath();
    g.moveTo(size, 0);
    g.lineTo(-size * 0.4, -size * 0.85);
    g.lineTo(-size * 0.1, 0);
    g.lineTo(-size * 0.4, size * 0.85);
    g.closePath();
    g.stroke();
    g.fill();
    g.restore();
    g.globalAlpha = 1;
  }

  /** A pulsing arrow at the screen edge on the side of your base where the zombies press hardest. */
  private drawPressureArrow(g: CanvasRenderingContext2D, now: number) {
    // Before a surge: yellow arrows at every side it will come from.
    if (this.incoming.length && this.myPlot >= 0) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 220);
      for (const side of this.incoming) this.edgeArrow(g, side, THEME.siege.incoming, (14 + 4 * pulse) * this.dpr, 0.55 + 0.45 * pulse);
    }
    const pr = this.pressure;
    if (!pr || this.myPlot < 0 || now - pr.at > 3000) return;
    const total = pr.sides.reduce((a, b) => a + b, 0);
    let side = 0;
    for (let i = 1; i < 4; i++) if (pr.sides[i]! > pr.sides[side]!) side = i;
    const share = total ? pr.sides[side]! / total : 0;
    if (pr.sides[side]! < 4 || share < 0.3) return;
    const d = this.dpr;
    const p = world.plots[this.myPlot]!;
    const [bx, by] = this.toScreen((p.x + PLOT / 2) * T, (p.y + PLOT / 2) * T);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const m = 34 * d;
    const top = 64 * d; // clear of the map buttons and minimap
    const x = side === 1 ? W - m : side === 3 ? m : Math.max(m, Math.min(W - m, bx));
    const y = side === 0 ? top : side === 2 ? H - m : Math.max(top, Math.min(H - m, by));
    const pulse = 0.5 + 0.5 * Math.sin(now / 140);
    const size = (12 + 4 * pulse + 6 * Math.min(1, share)) * d;
    const ang = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][side]!;
    g.save();
    g.translate(Math.round(x), Math.round(y));
    g.rotate(ang);
    g.globalAlpha = 0.55 + 0.45 * pulse;
    g.fillStyle = `rgb(${THEME.siege.arrow.join(', ')})`;
    g.strokeStyle = THEME.siege.arrowOutline;
    g.lineWidth = 2 * d;
    g.beginPath();
    g.moveTo(size, 0);
    g.lineTo(-size * 0.4, -size * 0.85);
    g.lineTo(-size * 0.1, 0);
    g.lineTo(-size * 0.4, size * 0.85);
    g.closePath();
    g.stroke();
    g.fill();
    g.restore();
    g.globalAlpha = 1;
  }

  /** Is a world point on (or near) the crate? Generous, so it's easy to tap on a phone. */
  crateAt(wx: number, wy: number): boolean {
    return !!this.crate && Math.hypot(wx - CRATE_SPOT.x, wy - (CRATE_SPOT.y - 8)) < Math.max(18, 28 / this.cam.k);
  }

  private drawCrate(g: CanvasRenderingContext2D, rarity: Rarity, now: number) {
    const img = (rarity === 'legendary' ? this.sprites.crateRed : rarity === 'epic' ? this.sprites.crateBlue : this.sprites.crateGreen).img;
    const color = THEME.crate[rarity];
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
    const fs = Math.round(THEME.tag.crateSize * d);
    const text = `${rarity.toUpperCase()} CRATE`;
    g.font = `${THEME.tag.crateWeight} ${fs}px ${FONT_DISPLAY}`;
    const w = g.measureText(text).width + 10 * d;
    const h = fs + 6 * d;
    g.fillStyle = `rgba(${THEME.crate[rarity]}, 0.92)`;
    g.fillRect(Math.round(sx - w / 2), Math.round(sy - h), w, h);
    g.fillStyle = THEME.tag.textDark;
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
    const G = world.ground;
    const W = world.w;
    const isRoad = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < world.h && (G[y * W + x] === 1 || G[y * W + x] === 3);
    const GRASS: [number, number][] = [[0, 0], [2, 0], [0, 2], [2, 2], [5, 0]];
    const DECALS: [number, number][] = [[3, 0], [3, 1], [4, 1], [5, 1], [3, 2], [4, 2]];
    // Only the tileset's plain tiles: the others carry borders that would tile into seams.
    const DIRT: [number, number][] = [[15, 1]];
    const pick = (set: [number, number][], wx: number, wy: number) => set[Math.floor(hash(wx, wy, 1) * set.length)]!;
    for (let ty = 0; ty < CHUNK; ty++)
      for (let tx = 0; tx < CHUNK; tx++) {
        const wx = cx * CHUNK + tx;
        const wy = cy * CHUNK + ty;
        if (wx >= W || wy >= world.h) continue;
        const gk = G[wy * W + wx];
        let sheet = this.tiles.grass;
        let src: [number, number];
        if (gk === 1 || gk === 3) {
          g.drawImage(this.asphalt[Math.floor(hash(wx, wy, 2) * this.asphalt.length)]!, tx * T, ty * T);
          if (gk === 3) {
            g.fillStyle = THEME.alleyShade;
            g.fillRect(tx * T, ty * T, T, T);
          }
          continue;
        } else if (gk === 2) {
          sheet = this.tiles.earth;
          src = pick(DIRT, wx, wy);
        } else src = pick(hash(wx, wy) < 0.07 ? DECALS : GRASS, wx, wy);
        g.drawImage(sheet, src[0] * T, src[1] * T, T, T, tx * T, ty * T, T, T);
      }
    const ox = cx * size;
    const oy = cy * size;
    // Kerbs: a thin light edge wherever road meets something else.
    g.fillStyle = THEME.kerb;
    for (let ty = 0; ty < CHUNK; ty++)
      for (let tx = 0; tx < CHUNK; tx++) {
        const wx = cx * CHUNK + tx;
        const wy = cy * CHUNK + ty;
        if (!isRoad(wx, wy)) continue;
        if (!isRoad(wx - 1, wy)) g.fillRect(tx * T, ty * T, 1, T);
        if (!isRoad(wx + 1, wy)) g.fillRect(tx * T + T - 1, ty * T, 1, T);
        if (!isRoad(wx, wy - 1)) g.fillRect(tx * T, ty * T, T, 1);
        if (!isRoad(wx, wy + 1)) g.fillRect(tx * T, ty * T + T - 1, T, 1);
      }
    // Dashed yellow centre lines, broken at junctions.
    g.fillStyle = THEME.laneStripe;
    for (const st of world.streets) {
      if (st.dir === 'v') {
        const px = (st.x + st.w / 2) * T - 1 - ox;
        if (px < -2 || px > size) continue;
        for (let ty = st.y; ty < st.y + st.h; ty++) {
          if (G[ty * W + st.x - 1] === 1 || G[ty * W + st.x + st.w] === 1) continue;
          const py = ty * T - oy;
          if (py > -T && py < size) g.fillRect(px, py + 4, 2, 8);
        }
      } else {
        const py = (st.y + st.h / 2) * T - 1 - oy;
        if (py < -2 || py > size) continue;
        for (let tx = st.x; tx < st.x + st.w; tx++) {
          if (G[(st.y - 1) * W + tx] === 1 || G[(st.y + st.h) * W + tx] === 1) continue;
          const px = tx * T - ox;
          if (px > -T && px < size) g.fillRect(px + 4, py, 8, 2);
        }
      }
    }
    // Soft shadows first, then graves and scenery on top.
    const near = (x: number, y: number, m: number) => x > ox - m && y > oy - m && x < ox + size + m && y < oy + size + m;
    for (const pr of world.props) {
      if (isAnimatedProp(PROP_FILES[pr.f]!) || !near(pr.x, pr.y, 64)) continue;
      const img = this.sprites.props[pr.f]!;
      this.softShadow(g, pr.x - ox, pr.y - oy - 1, img.width * 0.42, Math.max(2.5, img.width * 0.15));
    }
    // Manholes on the kerbs around every plot (zombies climb out of them).
    for (const m of world.manholes) {
      const px = m.x * T - ox;
      const py = m.y * T - oy;
      if (px > -T && py > -T && px < size && py < size) g.drawImage(this.sprites.manhole.img, px, py);
    }
    for (const gy of world.graveyards)
      for (const gr of gy.graves) if (near(gr.x * T, gr.y * T, 32)) this.softShadow(g, gr.x * T + 8 - ox, gr.y * T + 14 - oy, 6, 2.5);
    for (const gy of world.graveyards) {
      for (const gr of gy.graves) {
        const px = gr.x * T - ox;
        const py = gr.y * T - oy;
        if (px > -T && py > -T && px < size && py < size) g.drawImage(this.sprites.graves[gr.kind]!, px, py);
      }
    }
    // Scenery, already sorted by y.
    for (const pr of world.props) {
      if (isAnimatedProp(PROP_FILES[pr.f]!)) continue;
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
    g.fillStyle = THEME.ruinFade;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'source-over';
    this.ruinCache.set(plot, c);
    return c;
  }

  /** Packed-dirt yard inside a lived-in compound (the same for every base: drawn once, then one image). */
  private drawYard(g: CanvasRenderingContext2D, ox: number, oy: number) {
    if (!this.yard) {
      const c = document.createElement('canvas');
      c.width = (RING.x1 - RING.x0 - 1) * T;
      c.height = (RING.y1 - RING.y0 - 1) * T;
      const yg = c.getContext('2d')!;
      for (let y = 0; y < c.height; y += T) for (let x = 0; x < c.width; x += T) yg.drawImage(this.tiles.earth, 15 * T, 1 * T, T, T, x, y, T, T);
      this.yard = c;
    }
    g.drawImage(this.yard, ox + (RING.x0 + 1) * T, oy + (RING.y0 + 1) * T);
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
    // Shadows: the Main Tower, and a soft band along the walls' sunny side.
    this.softShadow(g, ox + (HQ_RECT.x + HQ_RECT.w / 2) * T, oy + (HQ_RECT.y + HQ_RECT.h) * T - 1, HQ_RECT.w * T * 0.55, 6);
    g.fillStyle = THEME.shadow;
    g.globalAlpha = 0.45;
    g.fillRect(ox + RING.x0 * T + 2, oy + (RING.y1 + 1) * T, (RING.x1 - RING.x0 + 1) * T, 2);
    g.fillRect(ox + (RING.x1 + 1) * T, oy + RING.y0 * T + 3, 2, (RING.y1 - RING.y0 + 1) * T);
    g.globalAlpha = 1;
    if (l) this.drawGroundFx(g, l, now);
    const list = this.drawList;
    let n = 0;
    const put = (y: number, kind: number, i: number, unit: UnitView | null) => {
      const it = (list[n] ??= { y: 0, kind: 0, i: 0, unit: null });
      it.y = y;
      it.kind = kind;
      it.i = i;
      it.unit = unit;
      n++;
    };
    const reinforced = base.walls >= CONFIG.walls.reinforcedFromLevel;
    WALLS.forEach((w, i) => put(oy + w.y * T + 14, 0, i, null));
    put(oy + (HQ_RECT.y + HQ_RECT.h) * T, 1, 0, null);
    put(oy + (VAULT_RECT.y + VAULT_RECT.h) * T, 6, 0, null);
    const mine = plot === this.myPlot;
    const unlocked = slotsUnlocked(base.hq);
    SLOTS.forEach((s, i) => {
      if (base.posts[i]) put(oy + s.y * T + 15, 2, i, null);
      else if (mine) put(oy + s.y * T, 3, i, null);
    });
    const [, cfy] = commanderSpot({ x: 0, y: 0 });
    put(oy + cfy * T, 5, 0, null);
    const a = l ? Math.min(1, (now - l.lastSnapAt) / SNAP_MS) : 0;
    if (l) for (const u of l.units.values()) put(u.py + (u.y - u.py) * a, 4, 0, u);
    // Sort just the used part of the reused list (insertion sort: it's nearly sorted frame to frame).
    for (let i = 1; i < n; i++) {
      const it = list[i]!;
      let j = i - 1;
      while (j >= 0 && list[j]!.y > it.y) {
        list[j + 1] = list[j]!;
        j--;
      }
      list[j + 1] = it;
    }
    const lod = this.cam.k < LOD_K;
    for (let i = 0; i < n; i++) {
      const it = list[i]!;
      switch (it.kind) {
        case 0: {
          const w = WALLS[it.i]!;
          this.drawWall(g, ox + w.x * T, oy + w.y * T, w.dir, reinforced, l?.hp.get(wallId(w.i)) ?? 100);
          break;
        }
        case 1:
          this.drawHq(g, ox + HQ_RECT.x * T, oy + HQ_RECT.y * T, base.hq, l?.hp.get(HQ_ID) ?? 100);
          break;
        case 2: {
          const s = SLOTS[it.i]!;
          const post = base.posts[it.i]!;
          this.drawPost(g, ox + s.x * T, oy + s.y * T, it.i, post.type, post.level, l, now);
          break;
        }
        case 3: {
          const s = SLOTS[it.i]!;
          this.drawSlot(g, ox + s.x * T, oy + s.y * T, it.i < unlocked);
          break;
        }
        case 6:
          this.drawVault(g, ox + VAULT_RECT.x * T, oy + VAULT_RECT.y * T, l?.hp.get(VAULT_ID) ?? 100);
          break;
        case 5: {
          const wp = world.plots[plot]!;
          this.drawCommander(g, plot, base, l, now, ox - wp.x * T, oy - wp.y * T);
          break;
        }
        default: {
          const u = it.unit!;
          this.drawUnit(g, u, u.px + (u.x - u.px) * a, it.y, now, lod);
          it.unit = null;
        }
      }
    }
    if (l) {
      this.drawEffects(g, l, now);
      this.drawTapFx(g, l, now);
    }
  }

  /** Under the units: cracks zombies climb out of, and manholes with their lids pushed aside. */
  private drawGroundFx(g: CanvasRenderingContext2D, l: LiveState, now: number) {
    if (l.cracks.length) {
      let keep = 0;
      for (const c of l.cracks) {
        const age = now - c.at;
        if (age >= CRACK_MS) continue;
        l.cracks[keep++] = c;
        // Opens fast, then slowly fades back into the ground.
        g.globalAlpha = Math.min(1, age / 120) * Math.min(1, (CRACK_MS - age) / 1200);
        g.drawImage(this.crackImage(c.v), Math.round(c.x - 10), Math.round(c.y - 6));
      }
      l.cracks.length = keep;
      g.globalAlpha = 1;
    }
    for (const [i, until] of l.manholes) {
      if (now >= until) {
        l.manholes.delete(i);
        continue;
      }
      const m = world.manholes[i]!;
      g.fillStyle = THEME.siege.manholeHole;
      g.fillRect(m.x * T + 3, m.y * T + 4, 10, 8);
      g.fillRect(m.x * T + 4, m.y * T + 3, 8, 10);
      g.drawImage(this.sprites.manhole.img, m.x * T + 9, m.y * T + 5);
    }
  }

  private drawEffects(g: CanvasRenderingContext2D, l: LiveState, now: number) {
    l.tracers = l.tracers.filter((t) => now - t.at < 90);
    g.strokeStyle = THEME.tracer;
    g.lineWidth = 1;
    for (const t of l.tracers) {
      g.beginPath();
      g.moveTo(t.x0 + 0.5, t.y0 + 0.5);
      g.lineTo(t.x1 + 0.5, t.y1 + 0.5);
      g.stroke();
    }
    // Coins popping over kills: rise and fade.
    if (l.pops.length) {
      let keep = 0;
      for (const p of l.pops) {
        const k = (now - p.at) / POP_MS;
        if (k >= 1) continue;
        l.pops[keep++] = p;
        g.globalAlpha = k < 0.6 ? 1 : (1 - k) / 0.4;
        g.drawImage(p.img, Math.round(p.x - p.img.width / 2), Math.round(p.y - 10 * Math.sqrt(k)));
      }
      l.pops.length = keep;
      g.globalAlpha = 1;
    }
    // Dirt puffs where zombies claw out of the ground.
    l.puffs = l.puffs.filter((p) => now - p.at < 600);
    for (const p of l.puffs) {
      const k = (now - p.at) / 600;
      g.fillStyle = `rgba(${THEME.dirtPuff.join(', ')}, ${0.75 * (1 - k)})`;
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

  /** The vault (2x1 tiles at x, y): cracked open once raiders break it. */
  private drawVault(g: CanvasRenderingContext2D, x: number, y: number, hp: number) {
    const img = this.sprites.vault[hp <= 0 ? 1 : 0]!;
    this.softShadow(g, x + 16, y + 15, 14, 3);
    g.drawImage(img, x, y + T - img.height + 1);
    if (hp > 0 && hp < 100) this.hpBar(g, x + 6, y + T - img.height - 2, 20, hp);
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
      g.fillStyle = THEME.levelPip.back;
      g.fillRect(x + 6 + i * 5, y + 31, 4, 3);
      g.fillStyle = THEME.levelPip.on;
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
    g.fillStyle = THEME.levelPip.back;
    g.fillRect(x + 11, y + 11, 6, 6);
    g.fillStyle = THEME.levelPip.on;
    this.tinyDigit(g, level, x + 12, y + 12);
    if (hp < 100) this.hpBar(g, x + 1, y - 10, 14, hp);
  }

  private drawSlot(g: CanvasRenderingContext2D, x: number, y: number, unlocked: boolean) {
    g.fillStyle = unlocked ? THEME.slotOpen : THEME.slotLocked;
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
      g.fillStyle = THEME.levelPip.back;
      g.fillRect(x + 5, y + 7, 6, 5);
      g.fillRect(x + 6, y + 4, 1, 3);
      g.fillRect(x + 9, y + 4, 1, 3);
      g.fillRect(x + 6, y + 4, 4, 1);
    }
  }

  private drawUnit(g: CanvasRenderingContext2D, u: UnitView, x: number, y: number, now: number, lod: boolean) {
    const kind = UNIT_KINDS[u.kind] ?? 'z_small';
    if (kind.startsWith('r_')) return this.drawRaider(g, u, kind, x, y, now);
    const sh = ZOMBIE_SHEETS[kind]![u.facing < 0 ? 1 : 0];
    const s = this.sprites;
    let sheet: Sheet;
    let frame: number;
    if (u.state === 3) {
      // Rising: the death animation played backwards, climbing out of the ground.
      sheet = s[sh.death] as Sheet;
      const k = Math.min(1, (now - u.bornAt) / (CONFIG.siege.riseTime * 1000));
      frame = Math.max(0, sheet.frames - 1 - Math.floor(k * sheet.frames));
    } else if (u.state === 2) {
      sheet = s[sh.death] as Sheet;
      frame = Math.min(sheet.frames - 1, Math.floor((now - u.diedAt) / 90));
    } else if (u.state === 1) {
      sheet = s[sh.attack] as Sheet;
      frame = lod ? 0 : Math.floor(now / 110 + u.id);
    } else {
      sheet = s[sh.walk] as Sheet;
      frame = lod ? 0 : Math.floor(now / (120 / CONFIG.pace.zombieSpeed) + u.id); // legs keep up with the walking pace
    }
    const f = ((frame % sheet.frames) + sheet.frames) % sheet.frames;
    const fade = u.walkIn && now - u.bornAt < 250;
    if (fade) g.globalAlpha = (now - u.bornAt) / 250;
    if (!lod) {
      g.fillStyle = THEME.unitShadow;
      g.fillRect(Math.round(x - 4), Math.round(y - 1), 8, 2);
    }
    // The boss is a Big drawn at twice the size.
    const k = kind === 'z_boss' ? 2 : 1;
    g.drawImage(sheet.img, f * sheet.fw, 0, sheet.fw, sheet.fh, Math.round(x - (sheet.fw * k) / 2), Math.round(y - sheet.fh * k + 1), sheet.fw * k, sheet.fh * k);
    if (fade) g.globalAlpha = 1;
    if (!lod && u.state < 2 && (u.hp < 100 || k > 1)) this.hpBar(g, Math.round(x - 5 * k), Math.round(y - sheet.fh * k - 2), 10 * k, u.hp, THEME.hp.unit);
  }

  private drawRaider(g: CanvasRenderingContext2D, u: UnitView, kind: string, x: number, y: number, now: number) {
    const look = RAIDER_LOOK[kind]!;
    g.fillStyle = THEME.unitShadow;
    g.fillRect(Math.round(x - 4), Math.round(y - 1), 8, 2);
    if (u.state === 2) {
      const d = this.sprites.bodyDeath;
      g.globalAlpha = 0.85;
      drawFrame(g, d, Math.min(d.frames - 1, Math.floor((now - u.diedAt) / 90)), x - d.fw / 2, y - d.fh, u.facing < 0);
      g.globalAlpha = 1;
      return;
    }
    const frame = Math.floor(now / (u.state === 0 ? 100 / CONFIG.pace.raiderSpeed : 100) + u.id) % 6;
    // Raiders are tinted red; your squad member (same roster) keeps their own colours.
    const img = this.survivor(look.weapon, look.helmet, frame, u.state === 0, u.id === ALLY_ID ? null : THEME.raiderTint);
    const ox = Math.round(x - 14);
    const oy = Math.round(y - 19);
    if (u.facing < 0) {
      g.save();
      g.translate(ox + 28, oy);
      g.scale(-1, 1);
      g.drawImage(img, 0, 0);
      g.restore();
    } else g.drawImage(img, ox, oy);
    if (u.hp < 100) this.hpBar(g, Math.round(x - 5), Math.round(y - 20), 10, u.hp, THEME.hp.unit);
  }

  private drawGraveWarning(g: CanvasRenderingContext2D, gx: number, gy: number, state: number, now: number) {
    const cx = (gx + 3) * T;
    const cy = gy * T - 8;
    const pulse = 0.6 + 0.4 * Math.sin(now / 150);
    g.fillStyle = `rgba(${(state === 2 ? THEME.graveWave : THEME.graveWarn).join(', ')}, ${pulse})`;
    // A small skull-ish marker: rounded block with two eye holes.
    g.fillRect(cx - 4, cy - 6, 8, 6);
    g.fillRect(cx - 3, cy, 6, 2);
    g.fillStyle = THEME.levelPip.back;
    g.fillRect(cx - 3, cy - 4, 2, 2);
    g.fillRect(cx + 1, cy - 4, 2, 2);
  }

  private drawDeployZone(g: CanvasRenderingContext2D, p: WorldPlot, now: number) {
    const a = 0.18 + 0.08 * Math.sin(now / 250);
    g.fillStyle = `rgba(${THEME.deploy.fill.join(', ')}, ${a})`;
    for (let y = 0; y < PLOT; y++) for (let x = 0; x < PLOT; x++) if (inDeployZone(x, y)) g.fillRect((p.x + x) * T, (p.y + y) * T, T, T);
    g.strokeStyle = THEME.deploy.edge;
    g.lineWidth = 1;
    g.strokeRect(p.x * T + 0.5, p.y * T + 0.5, PLOT * T - 1, PLOT * T - 1);
    g.strokeRect((p.x + RING.x0) * T + 0.5, (p.y + RING.y0) * T + 0.5, (RING.x1 - RING.x0 + 1) * T - 1, (RING.y1 - RING.y0 + 1) * T - 1);
  }

  private drawPick(g: CanvasRenderingContext2D, p: WorldPlot, pick: BasePick, now: number) {
    const pulse = 0.55 + 0.35 * Math.sin(now / 180);
    g.strokeStyle = `rgba(${THEME.pick.join(', ')}, ${pulse})`;
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

  /** The tag as a small cached image in the base's banner colour; text is only re-rendered when it changes. */
  private tagImage(p: WorldPlot, s: BaseSummary): HTMLCanvasElement {
    const d = this.dpr;
    const small = this.zoom < 2;
    const mine = p.id === this.myPlot;
    const shielded = Math.max(s.shield, s.immune) > Date.now() + this.clockSkew;
    const text = `${mine ? '★ ' : ''}${small ? s.name : `${s.name}  Lv${s.hq}  ♛${s.trophies}`}`;
    const key = `${text}|${s.id}|${mine}|${shielded}|${s.raid ? 1 : 0}|${small}|${d}|${s.mode}|${s.vaultFull}`;
    const hit = this.tagCache.get(p.id);
    if (hit && hit.key === key) return hit.canvas;
    const t = THEME.tag;
    const fs = Math.round((small ? t.sizeSmall : t.size) * d);
    const font = `${t.font} ${fs}px ${FONT}`;
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = font;
    const tw = Math.ceil(g.measureText(text).width);
    const padX = Math.round(t.padX * d);
    const border = Math.max(1, Math.round((mine || s.raid ? 2 : 1) * d));
    const extra = (shielded ? fs + 3 * d : 0) + (s.raid ? fs + 3 * d : 0);
    c.width = Math.ceil(tw + padX * 2 + extra + border * 2);
    c.height = Math.ceil(fs + t.padY * 2 * d + border * 2);
    const h = c.height;
    const r = Math.round(4 * d);
    const box = (inset: number) => {
      g.beginPath();
      if (g.roundRect) g.roundRect(inset, inset, c.width - inset * 2, h - inset * 2, Math.max(0, r - inset));
      else g.rect(inset, inset, c.width - inset * 2, h - inset * 2);
    };
    // Outline (gold for your own base, red while raided, dark otherwise), then the banner colour.
    g.fillStyle = mine ? THEME.mine : s.raid ? t.raid : t.outline;
    box(0);
    g.fill();
    g.fillStyle = baseColor(s.id);
    box(border);
    g.fill();
    g.font = font;
    g.fillStyle = textOn(s.id);
    g.textBaseline = 'middle';
    g.fillText(text, border + padX, h / 2 + d);
    let ix = border + padX + tw + 3 * d;
    if (shielded) {
      const rr = fs / 2;
      g.fillStyle = t.shield;
      g.strokeStyle = THEME.tag.textDark;
      g.lineWidth = Math.max(1, d);
      g.beginPath();
      g.moveTo(ix, h / 2 - rr);
      g.lineTo(ix + rr * 2, h / 2 - rr);
      g.lineTo(ix + rr * 2, h / 2);
      g.quadraticCurveTo(ix + rr * 2, h / 2 + rr, ix + rr, h / 2 + rr * 1.2);
      g.quadraticCurveTo(ix, h / 2 + rr, ix, h / 2);
      g.closePath();
      g.fill();
      g.stroke();
      ix += fs + 3 * d;
    }
    if (s.raid) {
      g.fillStyle = t.raid;
      g.fillText('⚔', ix, h / 2 + d);
    }
    const out = this.withModeChips(c, s, d);
    this.tagCache.set(p.id, { key, canvas: out });
    return out;
  }

  /** The tag with a row of chips under it: the owner's mode, and "vault full" for a grinder with a full vault. */
  private withModeChips(tag: HTMLCanvasElement, s: BaseSummary, d: number): HTMLCanvasElement {
    const M = THEME.modes;
    const chips: [string, string][] = [s.mode === 'pvp' ? ['RAIDING', M.pvp] : ['GRINDING', M.pve]];
    if (s.vaultFull) chips.push(['VAULT FULL', M.vaultFull]);
    const fs = Math.round(M.chipSize * d);
    const g0 = document.createElement('canvas').getContext('2d')!;
    g0.font = `${fs}px ${FONT_DISPLAY}`;
    const padX = Math.round(3 * d);
    const gap = Math.round(3 * d);
    const widths = chips.map(([text]) => Math.ceil(g0.measureText(text).width) + padX * 2);
    const rowW = widths.reduce((a, w) => a + w, 0) + gap * (chips.length - 1);
    const chipH = fs + Math.round(4 * d);
    const c = document.createElement('canvas');
    c.width = Math.max(tag.width, rowW);
    c.height = tag.height + Math.round(2 * d) + chipH;
    const g = c.getContext('2d')!;
    g.drawImage(tag, Math.round((c.width - tag.width) / 2), 0);
    let x = Math.round((c.width - rowW) / 2);
    const y = tag.height + Math.round(2 * d);
    g.font = `${fs}px ${FONT_DISPLAY}`;
    g.textBaseline = 'middle';
    chips.forEach(([text, color], i) => {
      g.fillStyle = M.chipOutline;
      g.fillRect(x - 1, y - 1, widths[i]! + 2, chipH + 2);
      g.fillStyle = color;
      g.fillRect(x, y, widths[i]!, chipH);
      g.fillStyle = M.chipInk;
      g.fillText(text, x + padX, y + chipH / 2 + d * 0.5);
      x += widths[i]! + gap;
    });
    return c;
  }

  private hpBar(g: CanvasRenderingContext2D, x: number, y: number, w: number, pct: number, color: string = THEME.hp.good) {
    g.fillStyle = THEME.hp.back;
    g.fillRect(x - 1, y - 1, w + 2, 3);
    g.fillStyle = pct > 35 ? color : THEME.hp.low;
    g.fillRect(x, y, Math.max(1, Math.round((w * pct) / 100)), 1);
  }

  private tinyDigit(g: CanvasRenderingContext2D, n: number, x: number, y: number) {
    const D: Record<number, string> = { 1: '010110010111', 2: '111001111100', 3: '111011001111', 4: '101101111001', 5: '111110001110', 6: '100111101111', 7: '111001010010', 8: '111111101111' };
    const bits = D[n] ?? D[8]!;
    for (let i = 0; i < 12; i++) if (bits[i] === '1') g.fillRect(x + (i % 3), y + Math.floor(i / 3), 1, 1);
  }

  // ---- ambient life ---------------------------------------------------------------------------------

  /** A soft radial blob (64x64), made once per colour and reused for shadows and fog. */
  private radialBlob(rgba: string, fade: string): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba);
    grad.addColorStop(0.55, rgba);
    grad.addColorStop(1, fade);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  /** A soft, blurred ellipse shadow, nudged away from the sun (top left). */
  private softShadow(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
    const img = (this.blob.shadow ??= this.radialBlob(THEME.shadow, 'rgba(0, 0, 0, 0)'));
    const smooth = g.imageSmoothingEnabled;
    g.imageSmoothingEnabled = true;
    g.drawImage(img, x + THEME.shadowOffset.x - rx, y + THEME.shadowOffset.y - ry, rx * 2, ry * 2);
    g.imageSmoothingEnabled = smooth;
  }

  /** Grass tufts on screen lean back and forth (the pack's 2-frame grass sheets), each on its own beat. */
  private drawSwayingGrass(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, now: number) {
    for (const s of this.swayers) {
      if (s.x < x0 - 16 || s.x > x1 + 16 || s.y < y0 || s.y - 16 > y1) continue;
      const fw = s.img.width / 2;
      const frame = Math.floor(now / (700 + s.seed * 500) + s.seed * 7) % 2;
      g.drawImage(s.img, frame * fw, 0, fw, s.img.height, Math.round(s.x - fw / 2), s.y - s.img.height, fw, s.img.height);
    }
  }

  /** Each base's banner, in its own colour, waving above the compound's corner. */
  private drawFlag(g: CanvasRenderingContext2D, p: WorldPlot, id: number, now: number) {
    let frames = this.flagCache.get(id);
    if (!frames) {
      const main = baseColor(id);
      const dark = baseColor(id, THEME.banner.light - 16);
      frames = [0, 1].map((beat) => {
        const c = document.createElement('canvas');
        c.width = 11;
        c.height = 23;
        const f = c.getContext('2d')!;
        f.fillStyle = THEME.flagPole;
        f.fillRect(1, 0, 1, 22);
        f.fillRect(0, 21, 3, 1);
        for (let i = 0; i < 9; i++) {
          const dy = (Math.floor(i / 3) + beat) % 2;
          f.fillStyle = main;
          f.fillRect(2 + i, 1 + dy, 1, 5);
          f.fillStyle = dark;
          f.fillRect(2 + i, 5 + dy, 1, 1);
        }
        return c;
      });
      this.flagCache.set(id, frames);
    }
    const beat = Math.floor(now / 240 + hash(id, 3) * 4) % 2;
    g.drawImage(frames[beat]!, (p.x + RING.x0) * T + 6, (p.y + RING.y0) * T - 16);
  }

  /** Drifting green fog and rising embers at a graveyard; brighter while its zombies are rising. */
  private drawGraveyardFx(g: CanvasRenderingContext2D, id: number, cx: number, cy: number, state: number, now: number) {
    const boost = state === 2 ? 1.8 : state === 1 ? 1.4 : 1;
    const [fr, fg, fb] = THEME.fog;
    const fog = (this.blob.fog ??= this.radialBlob(`rgb(${fr}, ${fg}, ${fb})`, `rgba(${fr}, ${fg}, ${fb}, 0)`));
    const smooth = g.imageSmoothingEnabled;
    g.imageSmoothingEnabled = true;
    g.globalAlpha = Math.min(1, 0.1 * boost);
    for (let i = 0; i < 3; i++) {
      const t = (now / 1000) * 0.12 + i * 2.1 + id;
      g.drawImage(fog, cx + Math.sin(t) * 22 - 36, cy + 8 + Math.cos(t * 0.8) * 8 - 13, 72, 26);
    }
    g.globalAlpha = 1;
    g.imageSmoothingEnabled = smooth;
    if (!this.emberStyle.glow) {
      this.emberStyle.glow = `rgb(${THEME.ember.join(', ')})`;
      this.emberStyle.core = `rgb(${THEME.emberHot.join(', ')})`;
    }
    const count = Math.round(12 * boost);
    for (let i = 0; i < count; i++) {
      const seed = hash(id, i, 9);
      const life = 2400 + seed * 1800;
      const ph = ((now + seed * 10000) % life) / life;
      const ex = cx + (hash(id, i, 10) - 0.5) * 72 + Math.sin(ph * 6 + i) * 4;
      const ey = cy + 18 - ph * 46;
      const a = Math.sin(ph * Math.PI);
      g.globalAlpha = 0.35 * a;
      g.fillStyle = this.emberStyle.glow;
      g.fillRect(Math.round(ex) - 1, Math.round(ey) - 1, 3, 3);
      g.globalAlpha = 0.9 * a;
      g.fillStyle = this.emberStyle.core;
      g.fillRect(Math.round(ex), Math.round(ey), 1, 1);
    }
    g.globalAlpha = 1;
  }

  /** Rain on the ground (world space): puddles with the pack's splash animations, and drop splashes. */
  private drawRainGround(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, wet: number, now: number) {
    const s = this.sprites;
    for (const p of this.puddles) {
      if (p.x < x0 - 20 || p.x > x1 + 20 || p.y < y0 - 10 || p.y > y1 + 10) continue;
      const grow = Math.min(1, wet * 1.4) * p.r;
      if (grow < 2) continue;
      g.fillStyle = THEME.puddle;
      g.beginPath();
      g.ellipse(p.x, p.y, grow, grow * 0.45, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = THEME.puddleShine;
      g.fillRect(Math.round(p.x - grow * 0.4), Math.round(p.y - grow * 0.2), Math.max(1, Math.round(grow * 0.5)), 1);
      // Now and then a drop lands in it.
      const period = 900 + p.seed * 1400;
      const ph = ((now + p.seed * 5000) % period) / period;
      if (ph < 0.45) drawFrame(g, s.puddleSplash, Math.floor((ph / 0.45) * s.puddleSplash.frames), p.x - s.puddleSplash.fw / 2, p.y - s.puddleSplash.fh + 3);
    }
    const n = Math.round(26 * wet);
    const w = x1 - x0;
    const h = y1 - y0;
    for (let i = 0; i < n; i++) {
      const period = 420 + (i % 5) * 60;
      const cycle = Math.floor((now + i * 97) / period);
      const ph = ((now + i * 97) % period) / period;
      const sheet = i % 4 === 0 ? s.rainSplashBig : s.rainSplash;
      const x = x0 + hash(i, cycle, 31) * w;
      const y = y0 + hash(i, cycle, 32) * h;
      drawFrame(g, sheet, Math.floor(ph * sheet.frames), x - sheet.fw / 2, y - sheet.fh);
    }
  }

  /** Rain in the air (screen space): falling streaks and a cool tint. */
  private drawRainAir(g: CanvasRenderingContext2D, wet: number, now: number) {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const d = this.dpr;
    g.fillStyle = THEME.rainTint;
    g.globalAlpha = wet;
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
    g.strokeStyle = THEME.rain;
    g.lineWidth = Math.max(1, d);
    g.beginPath();
    const n = Math.round(THEME.weather.drops * wet * Math.max(1, (W * H) / (1920 * 1080)));
    for (let i = 0; i < n; i++) {
      const speed = (0.8 + hash(i, 4, 21) * 0.5) * d;
      const x = (hash(i, 1, 21) * (W + 80) - ((now * speed * 0.25) % (W + 80)) + W + 80) % (W + 80);
      const y = (hash(i, 2, 21) * (H + 60) + now * speed) % (H + 60) - 30;
      g.moveTo(x, y);
      g.lineTo(x - 3 * d, y + 11 * d);
    }
    g.stroke();
  }

}
