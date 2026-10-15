import {
  CONFIG,
  GRID,
  HQ_ID,
  HQ_RECT,
  RING,
  SLOTS,
  UNIT_KINDS,
  WALLS,
  postId,
  slotsUnlocked,
  wallId,
  type BaseState,
  type PostType,
  type Snapshot,
} from '@siege/shared';
import { LAYER_OFFSET, drawFrame, type Sheet, type Sprites } from './sprites.ts';

// Draws one base on a canvas at an integer scale (nearest-neighbour, no smoothing) and plays back
// the combat snapshots streamed by the server. Pure rendering: it never decides anything.

const T = 16;
const W = GRID * T;
const SNAP_MS = (1000 * CONFIG.snapshotEvery) / CONFIG.tickRate;

export type Pick = { kind: 'hq' } | { kind: 'walls' } | { kind: 'slot'; slot: number };

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
}

interface Tracer {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  at: number;
}

const ZOMBIE_SHEETS: Record<string, { walk: keyof Sprites; attack: keyof Sprites; death: keyof Sprites }> = {
  z_small: { walk: 'zSmallWalk', attack: 'zSmallAttack', death: 'zSmallDeath' },
  z_big: { walk: 'zBigWalk', attack: 'zBigAttack', death: 'zBigDeath' },
  z_axe: { walk: 'zAxeWalk', attack: 'zAxeAttack', death: 'zAxeDeath' },
};

function hash(x: number, y: number, s = 0) {
  let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class Board {
  readonly g: CanvasRenderingContext2D;
  scale = 1;
  base: BaseState | null = null;
  /** The base the current wave is being fought on (posts built mid-wave join next wave). */
  waveBase: BaseState | null = null;
  selected: Pick | null = null;
  private ground: HTMLCanvasElement;
  private units = new Map<number, UnitView>();
  private hp = new Map<number, number>();
  private tracers: Tracer[] = [];
  private postFacing = new Map<number, number>();
  private lastShot = new Map<number, number>();
  private lastSnapAt = 0;
  private composites = new Map<string, HTMLCanvasElement>();

  constructor(readonly canvas: HTMLCanvasElement, readonly sprites: Sprites) {
    this.g = canvas.getContext('2d')!;
    this.ground = this.bakeGround();
  }

  /** Largest integer scale that fits the available CSS box (in device pixels). */
  fit(cssW: number, cssH: number) {
    const dpr = window.devicePixelRatio || 1;
    const k = Math.max(1, Math.floor((Math.min(cssW, cssH) * dpr) / W));
    if (k === this.scale && this.canvas.width === W * k) return;
    this.scale = k;
    this.canvas.width = W * k;
    this.canvas.height = W * k;
    this.canvas.style.width = `${(W * k) / dpr}px`;
    this.canvas.style.height = `${(W * k) / dpr}px`;
  }

  // ---- state from the server ----------------------------------------------------------------------

  resetCombat() {
    this.units.clear();
    this.hp.clear();
    this.tracers = [];
  }

  applySnapshot(s: Snapshot, now: number) {
    const seen = new Set<number>();
    for (const [id, kind, x, y, hp, state, facing] of s.u) {
      seen.add(id);
      const u = this.units.get(id);
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
        this.units.set(id, { id, kind, px: x, py: y, x, y, hp, state, facing, diedAt: state === 2 ? now : 0 });
      }
    }
    for (const id of this.units.keys()) if (!seen.has(id)) this.units.delete(id);
    for (const [id, hp] of s.b) this.hp.set(id, hp);
    for (const [pid, tx, ty] of s.s) {
      const slot = pid - 200;
      const sl = SLOTS[slot];
      if (!sl) continue;
      const x0 = sl.x * T + 8;
      const y0 = sl.y * T + 4;
      this.postFacing.set(pid, tx >= x0 ? 1 : -1);
      this.lastShot.set(pid, now);
      this.tracers.push({ x0, y0, x1: tx, y1: ty - 6, at: now });
    }
    this.lastSnapAt = now;
  }

  // ---- input --------------------------------------------------------------------------------------

  /** What sits under a tap (CSS pixel coordinates relative to the canvas). */
  pick(cssX: number, cssY: number): Pick | null {
    const r = this.canvas.getBoundingClientRect();
    const tx = Math.floor(((cssX / r.width) * W) / T);
    const ty = Math.floor(((cssY / r.height) * W) / T);
    if (tx >= HQ_RECT.x && tx < HQ_RECT.x + HQ_RECT.w && ty >= HQ_RECT.y - 1 && ty < HQ_RECT.y + HQ_RECT.h) return { kind: 'hq' };
    const slot = SLOTS.findIndex((s) => s.x === tx && (s.y === ty || s.y - 1 === ty));
    if (slot >= 0) return { kind: 'slot', slot };
    const onRing = (tx === RING.x0 || tx === RING.x1 || ty === RING.y0 || ty === RING.y1) && tx >= RING.x0 && tx <= RING.x1 && ty >= RING.y0 && ty <= RING.y1;
    if (onRing) return { kind: 'walls' };
    return null;
  }

  // ---- drawing ------------------------------------------------------------------------------------

  draw(now: number) {
    const g = this.g;
    const k = this.scale;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.ground, 0, 0);
    const base = this.base;
    if (!base) return;

    // Depth-sorted drawables: walls, HQ, posts, units.
    const items: { y: number; draw: () => void }[] = [];
    const reinforced = base.walls >= CONFIG.walls.reinforcedFromLevel;
    for (const w of WALLS) {
      const hp = this.hp.get(wallId(w.i)) ?? 100;
      items.push({ y: w.y * T + 14, draw: () => this.drawWall(w.x, w.y, w.dir, reinforced, hp) });
    }
    items.push({ y: (HQ_RECT.y + HQ_RECT.h) * T, draw: () => this.drawHq(base.hq, this.hp.get(HQ_ID) ?? 100) });
    const unlocked = slotsUnlocked(base.hq);
    SLOTS.forEach((s, i) => {
      const p = base.posts[i];
      if (p) {
        const pending = this.waveBase !== null && !this.waveBase.posts[i];
        items.push({ y: s.y * T + 15, draw: () => this.drawPost(i, p.type, p.level, now, pending) });
      } else {
        items.push({ y: s.y * T, draw: () => this.drawSlot(s.x, s.y, i < unlocked) });
      }
    });
    const a = Math.min(1, (now - this.lastSnapAt) / SNAP_MS);
    for (const u of this.units.values()) {
      const x = u.px + (u.x - u.px) * a;
      const y = u.py + (u.y - u.py) * a;
      items.push({ y, draw: () => this.drawUnit(u, x, y, now) });
    }
    items.sort((p, q) => p.y - q.y);
    for (const it of items) it.draw();

    // Shots.
    this.tracers = this.tracers.filter((t) => now - t.at < 90);
    g.strokeStyle = 'rgba(255, 230, 140, 0.9)';
    g.lineWidth = 1;
    for (const t of this.tracers) {
      g.beginPath();
      g.moveTo(t.x0 + 0.5, t.y0 + 0.5);
      g.lineTo(t.x1 + 0.5, t.y1 + 0.5);
      g.stroke();
    }

    // Selection highlight.
    if (this.selected) this.drawSelection(this.selected, now);
  }

  private drawWall(x: number, y: number, dir: 'h' | 'v', reinforced: boolean, hp: number) {
    const g = this.g;
    if (hp <= 0) {
      g.globalAlpha = 0.8;
      g.drawImage(this.sprites.debris.img, x * T + 1, y * T + 4);
      g.globalAlpha = 1;
      return;
    }
    if (dir === 'h') {
      const s = reinforced ? this.sprites.wallReinH : this.sprites.wallWoodH;
      g.drawImage(s.img, x * T, y * T + 1);
    } else {
      const s = reinforced ? this.sprites.wallReinV : this.sprites.wallWoodV;
      g.drawImage(s.img, x * T + 4, y * T);
    }
    if (hp < 100) this.hpBar(x * T + 2, y * T - 2, 12, hp);
  }

  private drawHq(level: number, hp: number) {
    const g = this.g;
    const s = this.sprites;
    const x = HQ_RECT.x * T;
    const y = HQ_RECT.y * T;
    const c = level >= 6 ? s.containerGreen : level >= 3 ? s.containerRed : s.containerGray;
    // Sandbag-ish pad: pallets under the container.
    g.drawImage(s.pallet.img, x - 2, y + 18);
    g.drawImage(c.img, x + 3, y + 4);
    if (level >= 2) g.drawImage(s.antenna1.img, x + 6, y - 8);
    if (level >= 4) g.drawImage(s.hvac.img, x + 24, y - 2);
    if (level >= 3) g.drawImage(s.barrelRust.img, x + 40, y + 14);
    if (level >= 5) g.drawImage(s.barrelBlue.img, x - 8, y + 12);
    if (level >= 7) g.drawImage(s.antenna2.img, x + 30, y - 10);
    if (hp < 100) this.hpBar(x + 4, y - 4, 40, hp);
    // Level pips.
    for (let i = 0; i < level; i++) {
      g.fillStyle = '#1b1712';
      g.fillRect(x + 6 + i * 5, y + 31, 4, 3);
      g.fillStyle = '#e3b341';
      g.fillRect(x + 7 + i * 5, y + 31, 2, 2);
    }
  }

  /** Survivor (body + weapon + helmet) cached per type/helmet/frame, mirrored as a whole. */
  private survivor(type: PostType, helmet: boolean, frame: number): HTMLCanvasElement {
    const key = `${type}${helmet ? 'h' : ''}${frame}`;
    let c = this.composites.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = 28;
    c.height = 20;
    const g = c.getContext('2d')!;
    const s = this.sprites;
    const bx = 9;
    const by = 2;
    drawFrame(g, s.body, frame, bx, by);
    if (helmet) drawFrame(g, s.helmet, frame, bx + LAYER_OFFSET.helmet.x, by + LAYER_OFFSET.helmet.y);
    drawFrame(g, s[type], frame, bx + LAYER_OFFSET[type].x, by + LAYER_OFFSET[type].y);
    this.composites.set(key, c);
    return c;
  }

  private drawPost(slot: number, type: PostType, level: number, now: number, pending: boolean) {
    const g = this.g;
    const s = SLOTS[slot]!;
    const id = postId(slot);
    const hp = this.hp.get(id) ?? 100;
    const x = s.x * T;
    const y = s.y * T;
    if (pending) g.globalAlpha = 0.55;
    if (hp > 0) {
      const frame = Math.floor(now / 160 + slot) % 6;
      const img = this.survivor(type, level >= CONFIG.posts.helmetFromLevel, frame);
      const face = this.postFacing.get(id) ?? (s.x < GRID / 2 ? -1 : 1);
      const ox = x + 8 - 14;
      const oy = y - 8;
      if (face < 0) {
        g.save();
        g.translate(ox + 28, oy);
        g.scale(-1, 1);
        g.drawImage(img, 0, 0);
        g.restore();
      } else g.drawImage(img, ox, oy);
      // Muzzle flash right after a shot.
      const shot = this.lastShot.get(id) ?? -1e9;
      if (now - shot < 70) {
        const f = LAYER_OFFSET.fire[type];
        const fx = face > 0 ? ox + 9 + LAYER_OFFSET[type].x + f.x : ox + 28 - (9 + LAYER_OFFSET[type].x + f.x) - this.sprites.fire.fw;
        drawFrame(g, this.sprites.fire, Math.floor((now - shot) / 25), fx, oy + 2 + LAYER_OFFSET[type].y + f.y, face < 0);
      }
    }
    // Barricade in front of the survivor.
    g.drawImage(this.sprites.wallWoodH.img, x, y + 6);
    g.globalAlpha = 1;
    // Level badge.
    g.fillStyle = '#1b1712';
    g.fillRect(x + 11, y + 11, 6, 6);
    g.fillStyle = '#e3b341';
    this.tinyDigit(level, x + 12, y + 12);
    if (hp < 100) this.hpBar(x + 1, y - 9, 14, hp);
  }

  private drawSlot(tx: number, ty: number, unlocked: boolean) {
    const g = this.g;
    const x = tx * T;
    const y = ty * T;
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
      // padlock
      g.fillStyle = 'rgba(30, 26, 20, 0.85)';
      g.fillRect(x + 5, y + 7, 6, 5);
      g.fillRect(x + 6, y + 4, 1, 3);
      g.fillRect(x + 9, y + 4, 1, 3);
      g.fillRect(x + 6, y + 4, 4, 1);
    }
  }

  private drawUnit(u: UnitView, x: number, y: number, now: number) {
    const kind = UNIT_KINDS[u.kind] ?? 'z_small';
    const sh = ZOMBIE_SHEETS[kind]!;
    const s = this.sprites;
    let sheet: Sheet;
    let frame: number;
    if (u.state === 2) {
      sheet = s[sh.death];
      frame = Math.min(sheet.frames - 1, Math.floor((now - u.diedAt) / 90));
    } else if (u.state === 1) {
      sheet = s[sh.attack];
      frame = Math.floor(now / 110 + u.id);
    } else {
      sheet = s[sh.walk];
      frame = Math.floor(now / 120 + u.id);
    }
    // Shadow, then the zombie standing on (x, y).
    this.g.fillStyle = 'rgba(0, 0, 0, 0.25)';
    this.g.fillRect(Math.round(x - 4), Math.round(y - 1), 8, 2);
    drawFrame(this.g, sheet, frame, x - sheet.fw / 2, y - sheet.fh + 1, u.facing < 0);
    if (u.state !== 2 && u.hp < 100) this.hpBar(Math.round(x - 5), Math.round(y - sheet.fh - 2), 10, u.hp, '#e0573f');
  }

  private drawSelection(p: Pick, now: number) {
    const g = this.g;
    const pulse = 0.55 + 0.35 * Math.sin(now / 180);
    g.strokeStyle = `rgba(255, 233, 150, ${pulse})`;
    g.lineWidth = 1;
    if (p.kind === 'hq') g.strokeRect(HQ_RECT.x * T - 3.5, HQ_RECT.y * T - 10.5, HQ_RECT.w * T + 7, HQ_RECT.h * T + 14);
    else if (p.kind === 'slot') {
      const s = SLOTS[p.slot]!;
      g.strokeRect(s.x * T - 1.5, s.y * T - 9.5, T + 3, T + 11);
    } else {
      g.strokeRect(RING.x0 * T - 0.5, RING.y0 * T - 0.5, (RING.x1 - RING.x0 + 1) * T + 1, (RING.y1 - RING.y0 + 1) * T + 1);
    }
  }

  private hpBar(x: number, y: number, w: number, pct: number, color = '#8fc46b') {
    const g = this.g;
    g.fillStyle = '#1b1712';
    g.fillRect(x - 1, y - 1, w + 2, 3);
    g.fillStyle = pct > 35 ? color : '#e0573f';
    g.fillRect(x, y, Math.max(1, Math.round((w * pct) / 100)), 1);
  }

  /** 3x4 pixel digits for level badges. */
  private tinyDigit(n: number, x: number, y: number) {
    const D: Record<number, string> = { 1: '010110010111', 2: '111001111100', 3: '111011001111', 4: '101101111001', 5: '111110001110', 6: '100111101111', 7: '111001010010', 8: '111111101111' };
    const bits = D[n] ?? D[8]!;
    for (let i = 0; i < 12; i++) if (bits[i] === '1') this.g.fillRect(x + (i % 3), y + Math.floor(i / 3), 1, 1);
  }

  // ---- ground ---------------------------------------------------------------------------------------

  /** Bleak-Yellow ground: plain dirt tiles mixed by hash, a slightly darker yard, and scattered scenery. */
  private bakeGround(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = W;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    const tiles = this.sprites.ground.img;
    // Picked by measuring the tileset: the most even dirt tiles (no edges or patterns).
    const plain: [number, number][] = [[0, 0], [2, 0], [14, 0], [16, 0], [0, 2], [2, 2], [14, 2], [16, 2], [5, 0]];
    const decals: [number, number][] = [[3, 1], [4, 0], [3, 2]];
    const yard: [number, number][] = [[15, 1]];
    for (let ty = 0; ty < GRID; ty++)
      for (let tx = 0; tx < GRID; tx++) {
        const inside = tx > RING.x0 && tx < RING.x1 && ty > RING.y0 && ty < RING.y1;
        const r = hash(tx, ty);
        const set = inside ? yard : r < 0.04 ? decals : plain;
        const [sx, sy] = set[Math.floor(hash(tx, ty, 1) * set.length)]!;
        g.drawImage(tiles, sx * T, sy * T, T, T, tx * T, ty * T, T, T);
      }
    // Scenery outside the walls (kept off the spawn edges' first row so zombies stay visible).
    const s = this.sprites;
    const props: [keyof Sprites, number, number][] = [
      ['tree3', 0, 3], ['tree1', 17, 1], ['tree9', 18, 15], ['bush1', 1, 17], ['bush2', 17, 7],
      ['tires', 1, 9], ['rock', 18, 11], ['grass1', 4, 18], ['grass2', 14, 1], ['grass1', 11, 18],
      ['cardboard', 15, 18], ['grass2', 1, 13], ['bush1', 10, 1],
    ];
    for (const [key, tx, ty] of props) {
      const sh = s[key];
      g.drawImage(sh.img, tx * T + Math.round((T - sh.fw) / 2), ty * T + T - sh.fh);
    }
    return c;
  }
}
