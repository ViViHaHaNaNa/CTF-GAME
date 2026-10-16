import { themeVar } from './theme.ts';

// Retro helpers for pixel-exact canvas screens: crisp text in the bundled arcade font, a tiny 3x5
// bitmap font, a chunky decorative frame drawn in code, and synthesised 8-bit sound effects.

// ---- crisp arcade text ------------------------------------------------------------------------------

const textCache = new Map<string, HTMLCanvasElement>();

/**
 * Text in the arcade font as a cached image with hard pixel edges (anti-aliasing is thresholded away).
 * `size` should be a multiple of 8 so glyphs sit on the font's pixel grid.
 */
export function pixelText(text: string, size: number, color: string): HTMLCanvasElement {
  const key = `${size}|${color}|${text}`;
  const hit = textCache.get(key);
  if (hit) return hit;
  const font = `${size}px ${themeVar('--font-pixel')}`;
  const c = document.createElement('canvas');
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.font = font;
  c.width = Math.max(1, Math.ceil(g.measureText(text).width));
  c.height = size;
  g.font = font;
  g.textBaseline = 'top';
  g.fillStyle = color;
  g.fillText(text, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i]! >= 110 ? 255 : 0;
  g.putImageData(d, 0, 0);
  if (textCache.size > 400) textCache.clear();
  textCache.set(key, c);
  return c;
}

/** Width in pixels of `text` in the arcade font at `size` (monospaced: one size-wide cell per char). */
export const pixelWidth = (text: string, size: number) => text.length * size;

/** Split text into lines of at most `max` characters (on spaces). */
export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > max) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

// ---- tiny 3x5 bitmap font -----------------------------------------------------------------------------

const TINY: Record<string, string> = {
  'A': '.#.#.#####.##.#', 'B': '##.#.###.#.###.', 'C': '.###..#..#...##', 'D': '##.#.##.##.###.',
  'E': '####..##.#..###', 'F': '####..##.#..#..', 'G': '.###..#.##.#.##', 'H': '#.##.#####.##.#',
  'I': '###.#..#..#.###', 'J': '..#..#..##.#.#.', 'K': '#.##.###.#.##.#', 'L': '#..#..#..#..###',
  'M': '#.########.##.#', 'N': '##.#.##.##.##.#', 'O': '.#.#.##.##.#.#.', 'P': '##.#.###.#..#..',
  'Q': '.#.#.##.###..##', 'R': '##.#.###.#.##.#', 'S': '.###...#...###.', 'T': '###.#..#..#..#.',
  'U': '#.##.##.##.####', 'V': '#.##.##.##.#.#.', 'W': '#.##.########.#', 'X': '#.##.#.#.#.##.#',
  'Y': '#.##.#.#..#..#.', 'Z': '###..#.#.#..###', '0': '####.##.##.####', '1': '.#.##..#..#.###',
  '2': '##...#.#.#..###', '3': '##...#.#...###.', '4': '#.##.####..#..#', '5': '####..##...###.',
  '6': '.###..####.####', '7': '###..#.#..#..#.', '8': '####.#####.####', '9': '####.####..###.',
  '.': '.............#.', ',': '..........#.#..', ':': '....#.....#....', '-': '......###......',
  "'": '.#..#..........', '/': '..#..#.#.#..#..', '(': '.#.#..#..#...#.', ')': '.#...#..#..#.#.',
  '!': '.#..#..#.....#.', '?': '##...#.#.....#.', '+': '....#.###.#....', '&': '.#.#.#.#.#.#.##',
  '#': '#.#####.#####.#', '|': '.#..#..#..#..#.', ' ': '...............',
};

/** Draw text in the 3x5 font (4 px per character). Unknown characters draw as blanks. */
export function tinyText(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  g.fillStyle = color;
  let cx = Math.round(x);
  for (const ch of text.toUpperCase()) {
    const bits = TINY[ch] ?? TINY[' ']!;
    // Each glyph is 15 cells: 3 wide x 5 tall, row by row.
    for (let i = 0; i < 15; i++) if (bits[i] === '#') g.fillRect(cx + (i % 3), Math.round(y) + Math.floor(i / 3), 1, 1);
    cx += 4;
  }
}

export const tinyWidth = (text: string) => text.length * 4 - 1;

// ---- frame & ornaments ---------------------------------------------------------------------------------

const SKULL = ['..#####..', '.#######.', '##.###.##', '#..###..#', '#########', '.###.###.', '..#.#.#..', '..#####..'];

/** A 9x8 pixel skull with glowing eyes. */
export function skull(g: CanvasRenderingContext2D, x: number, y: number) {
  const bone = themeVar('--title-skull');
  const eyes = themeVar('--title-skull-eyes');
  SKULL.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const c = row[rx];
      if (c === '#') {
        g.fillStyle = bone;
        g.fillRect(x + rx, y + ry, 1, 1);
      } else if (ry === 2 || ry === 3) {
        if ((rx === 2 || rx === 6) && ry === 3) {
          g.fillStyle = eyes;
          g.fillRect(x + rx, y + ry, 1, 1);
        }
      }
    }
  });
}

/**
 * A chunky frame: dark outline, a riveted metal pipe with rust patches, an inner highlight, and
 * skulls on the corners. `t` is the pipe thickness in pixels.
 */
export function chunkyFrame(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, t: number, skulls = true) {
  const dark = themeVar('--title-frame-dark');
  const mid = themeVar('--title-frame');
  const light = themeVar('--title-frame-light');
  const rust = themeVar('--title-frame-rust');
  const rivet = themeVar('--title-rivet');
  g.fillStyle = dark;
  g.fillRect(x, y, w, t);
  g.fillRect(x, y + h - t, w, t);
  g.fillRect(x, y, t, h);
  g.fillRect(x + w - t, y, t, h);
  g.fillStyle = mid;
  g.fillRect(x + 1, y + 1, w - 2, t - 2);
  g.fillRect(x + 1, y + h - t + 1, w - 2, t - 2);
  g.fillRect(x + 1, y + 1, t - 2, h - 2);
  g.fillRect(x + w - t + 1, y + 1, t - 2, h - 2);
  // Highlight along the top of each pipe.
  g.fillStyle = light;
  g.fillRect(x + 2, y + 1, w - 4, 1);
  g.fillRect(x + 2, y + h - t + 1, w - 4, 1);
  g.fillRect(x + 1, y + 2, 1, h - 4);
  g.fillRect(x + w - t + 1, y + 2, 1, h - 4);
  // Rust patches and rivets along the pipes.
  for (let i = x + 12; i < x + w - 12; i += 16) {
    g.fillStyle = (i / 16) % 3 < 1 ? rust : mid;
    g.fillRect(i + 5, y + t - 3, 4, 1);
    g.fillRect(i + 9, y + h - 3, 3, 1);
    g.fillStyle = rivet;
    g.fillRect(i, y + Math.floor(t / 2), 1, 1);
    g.fillRect(i, y + h - Math.ceil(t / 2), 1, 1);
  }
  for (let j = y + 12; j < y + h - 12; j += 16) {
    g.fillStyle = rivet;
    g.fillRect(x + Math.floor(t / 2), j, 1, 1);
    g.fillRect(x + w - Math.ceil(t / 2), j, 1, 1);
  }
  if (skulls && t >= 5) {
    for (const [sx, sy] of [[x, y], [x + w - 9, y], [x, y + h - 8], [x + w - 9, y + h - 8]] as const) {
      g.fillStyle = dark;
      g.fillRect(sx - 1, sy - 1, 11, 10);
      skull(g, sx, sy);
    }
  }
}

/** A solid right-pointing arrow, 5 wide and 7 tall. */
export function arrow(g: CanvasRenderingContext2D, x: number, y: number, color: string) {
  g.fillStyle = color;
  for (let i = 0; i < 4; i++) g.fillRect(x + i, y + i, 1, 7 - i * 2);
}

// ---- sound -----------------------------------------------------------------------------------------------

/** Tiny synthesised sound effects. Silent until the first user interaction (browser autoplay rules). */
export class Sfx {
  private ctx: AudioContext | null = null;
  muted: boolean;

  constructor(private readonly storageKey: string) {
    let m = false;
    try {
      m = localStorage.getItem(storageKey) === '1';
    } catch {
      /* private mode */
    }
    this.muted = m;
  }

  /** Call from a user gesture: creates/resumes the audio context. */
  unlock() {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  toggle() {
    this.muted = !this.muted;
    try {
      localStorage.setItem(this.storageKey, this.muted ? '1' : '0');
    } catch {
      /* fine */
    }
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime + start;
    const o = ctx.createOscillator();
    const v = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    v.gain.setValueAtTime(vol, t);
    v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(v).connect(ctx.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Cursor moved. */
  blip() {
    this.tone(880, 0, 0.05, 'square', 0.05);
  }

  /** Selection confirmed: a quick rising arpeggio. */
  confirm() {
    this.tone(523, 0, 0.07, 'square', 0.06);
    this.tone(784, 0.06, 0.07, 'square', 0.06);
    this.tone(1046, 0.12, 0.12, 'square', 0.06);
  }

  /** Something went wrong (e.g. login refused). */
  error() {
    this.tone(220, 0, 0.18, 'sawtooth', 0.05, 110);
  }
}
