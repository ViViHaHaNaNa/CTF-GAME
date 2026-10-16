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

  // ---- siege ----------------------------------------------------------------------------------------

  private noise: AudioBuffer | null = null;

  /** One second of white noise, made once (growls and the breach boom are filtered noise). */
  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    return (this.noise = b);
  }

  /** Air-raid siren: `long` for the first surge (three wails), short sting for a pincer. */
  siren(long: boolean) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    const wails = long ? 3 : 1;
    const each = long ? 0.9 : 0.55;
    for (const detune of [0, 7]) {
      const o = ctx.createOscillator();
      const v = ctx.createGain();
      o.type = 'sawtooth';
      o.detune.value = detune * 100;
      for (let i = 0; i < wails; i++) {
        o.frequency.setValueAtTime(440, t + i * each);
        o.frequency.exponentialRampToValueAtTime(880, t + i * each + each * 0.6);
        o.frequency.exponentialRampToValueAtTime(520, t + (i + 1) * each);
      }
      v.gain.setValueAtTime(0.0001, t);
      v.gain.exponentialRampToValueAtTime(0.035, t + 0.08);
      v.gain.setValueAtTime(0.035, t + wails * each - 0.15);
      v.gain.exponentialRampToValueAtTime(0.0001, t + wails * each);
      o.connect(v).connect(ctx.destination);
      o.start(t);
      o.stop(t + wails * each + 0.05);
    }
  }

  /** A zombie growl: band-passed noise over a wobbling low saw. `pan` -1 (left) .. 1 (right), `vol` 0..1. */
  growl(pan: number, vol: number) {
    const ctx = this.ctx;
    if (!ctx || this.muted || vol <= 0) return;
    const t = ctx.currentTime;
    const dur = 0.45 + Math.random() * 0.5;
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(ctx.destination);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.05 * vol, t + 0.06);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    env.connect(out);
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer(ctx);
    n.playbackRate.value = 0.6 + Math.random() * 0.3;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(260 + Math.random() * 200, t);
    bp.frequency.exponentialRampToValueAtTime(140 + Math.random() * 60, t + dur);
    bp.Q.value = 3;
    n.connect(bp).connect(env);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(70 + Math.random() * 40, t);
    o.frequency.exponentialRampToValueAtTime(45 + Math.random() * 20, t + dur);
    const wob = ctx.createOscillator();
    const wobAmt = ctx.createGain();
    wob.frequency.value = 9 + Math.random() * 6;
    wobAmt.gain.value = 12;
    wob.connect(wobAmt).connect(o.frequency);
    const og = ctx.createGain();
    og.gain.value = 0.5;
    o.connect(og).connect(env);
    n.start(t, Math.random() * 0.4, dur);
    o.start(t);
    wob.start(t);
    o.stop(t + dur);
    wob.stop(t + dur);
  }

  /** The Main Tower falls: a deep thump with a noisy tail. */
  boom() {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    this.tone(90, 0, 0.5, 'sine', 0.2, 35);
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(120, t + 0.7);
    const v = ctx.createGain();
    v.gain.setValueAtTime(0.12, t);
    v.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    n.connect(lp).connect(v).connect(ctx.destination);
    n.start(t, 0, 0.8);
  }

  /** A Commander shot: a noise crack with a low punch; bigger for the gun, a deep boom for the shotgun. */
  shot(weapon: 'pistol' | 'gun' | 'shotgun') {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    const big = weapon === 'shotgun' ? 1 : weapon === 'gun' ? 0.6 : 0.4;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = weapon === 'shotgun' ? 'lowpass' : 'bandpass';
    hp.frequency.value = weapon === 'shotgun' ? 1800 : 2600;
    const v = ctx.createGain();
    const dur = 0.06 + big * 0.14;
    v.gain.setValueAtTime(0.09 + big * 0.06, t);
    v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(hp).connect(v).connect(ctx.destination);
    n.start(t, Math.random() * 0.5, dur);
    this.tone(160 - big * 70, 0, dur, 'square', 0.04 + big * 0.05, 50);
  }

  /** Empty magazine. */
  dry() {
    this.tone(1800, 0, 0.02, 'square', 0.03);
  }

  /** Reload: two mechanical clicks. */
  reloadClick() {
    this.tone(700, 0, 0.03, 'square', 0.035);
    this.tone(500, 0.12, 0.04, 'square', 0.035);
  }

  /** A tap kill: a short high tick that climbs with the combo multiplier. */
  kill(mult: number) {
    this.tone(880 + 220 * (mult - 1), 0, 0.05, 'square', 0.03);
  }

  /** Airstrike called: a falling whistle. */
  whistle(seconds: number) {
    this.tone(1600, 0, seconds, 'sine', 0.035, 500);
  }

  /** A surge held: two bright notes. */
  held() {
    this.tone(659, 0, 0.08, 'square', 0.035);
    this.tone(988, 0.08, 0.14, 'square', 0.035);
  }
}

/** The one sound player for the whole page: the title screen and the game share its mute switch. */
export const sfx = new Sfx('siege.muted');
