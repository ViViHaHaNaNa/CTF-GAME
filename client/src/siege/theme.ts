// The game's look in one place: every colour, font and size the canvas uses. (Page UI colours live in
// theme.css as CSS variables.) Swap the whole style by editing these two files.

/** Bundled font (see theme.css @font-face); no internet needed. */
export const FONT = "'Siege Sans', system-ui, sans-serif";
export const FONT_MONO = "'Siege Mono', ui-monospace, monospace";

export const THEME = {
  /** Behind the map edges. */
  void: '#0d1424',

  /**
   * Palette remap of the pack's Green ground tileset, applied at load time (the files are untouched).
   * Each tile type has its own rule. Hues in degrees, saturation/lightness 0..1.
   */
  remap: {
    /** Grass tiles: greens get vivid; grey detail pixels become deep green; flowers get brighter. */
    grass: { hue: 112, hueSpread: 0.25, satScale: 1.8, satMax: 0.8, lightScale: 1.1, lightMax: 0.78, detailHue: 128, detailSat: 0.55, detailLight: 0.9 },
    /** Dirt and paving: warmer and richer. */
    earth: { hueShift: 8, satScale: 1.5, satMax: 0.72, lightScale: 1.04, greyHue: 20, greySat: 0.35, greyLight: 0.9 },
  },

  /** Streets: deep blue asphalt (generated texture: base colour with light and dark specks). */
  asphalt: { base: '#233670', light: '#2e4589', dark: '#1a2857', lightShare: 0.07, darkShare: 0.07 },
  /** Alleys are a shade darker than streets. */
  alleyShade: 'rgba(0, 0, 0, 0.14)',
  /** Road markings. */
  laneStripe: '#ffd23f',
  kerb: 'rgba(210, 225, 255, 0.55)',

  /** Soft shadows (sun from the top left). */
  shadow: 'rgba(8, 14, 30, 0.34)',
  shadowOffset: { x: 3, y: 2 },

  /** Graveyard atmosphere. */
  ember: [255, 140, 40] as [number, number, number],
  emberHot: [255, 224, 120] as [number, number, number],
  fog: [150, 255, 190] as [number, number, number],
  graveWarn: [255, 196, 64] as [number, number, number],
  graveWave: [255, 76, 60] as [number, number, number],

  /** Rain. */
  rain: 'rgba(190, 215, 255, 0.55)',
  rainTint: 'rgba(30, 60, 140, 0.10)',
  puddle: 'rgba(40, 70, 150, 0.55)',
  puddleShine: 'rgba(200, 225, 255, 0.55)',
  /** Seconds: one shower every `every`, lasting `lasts`, fading over `fade`. */
  weather: { every: 360, lasts: 75, fade: 8, drops: 90 },

  /** Base banners: each base gets its own hue from its player id. */
  banner: { sat: 82, light: 56 },
  /** Your own base's tag outline. */
  mine: '#ffd23f',

  tag: {
    font: 700,
    size: 12,
    sizeSmall: 10,
    padX: 6,
    padY: 3,
    textDark: '#101624',
    textLight: '#ffffff',
    raid: '#ff4d3d',
    shield: '#7fd8ff',
  },

  crate: { rare: '120, 220, 90', epic: '90, 160, 255', legendary: '255, 80, 60' },

  hp: { good: '#6ee07a', low: '#ff4d3d', unit: '#ff6b5a', back: '#101624' },
  tracer: 'rgba(255, 240, 150, 0.95)',
  dirtPuff: [150, 110, 70] as [number, number, number],
  deploy: { fill: [255, 77, 61] as [number, number, number], edge: 'rgba(255, 150, 130, 0.85)' },
  pick: [255, 233, 120] as [number, number, number],
  slotOpen: 'rgba(255, 210, 63, 0.9)',
  slotLocked: 'rgba(16, 22, 36, 0.6)',
  levelPip: { back: '#101624', on: '#ffd23f' },
  flagPole: '#1c2233',
  raiderTint: 'rgba(230, 40, 40, 0.35)',
  ruinFade: 'rgba(30, 40, 60, 0.42)',

  minimap: {
    ground: [70, 150, 70] as [number, number, number],
    street: [40, 60, 120] as [number, number, number],
    mud: [110, 70, 45] as [number, number, number],
    alley: [55, 75, 125] as [number, number, number],
    empty: '#24324a',
    view: '#ffffff',
  },
} as const;

/** Each base's banner colour, the same on every screen (golden-angle hues by player id). */
export function baseHue(id: number): number {
  return Math.round((id * 137.508 + 20) % 360);
}

export function baseColor(id: number, light: number = THEME.banner.light): string {
  return `hsl(${baseHue(id)}, ${THEME.banner.sat}%, ${light}%)`;
}

/** Dark or light text, whichever reads better on a banner colour. */
export function textOn(id: number): string {
  const h = baseHue(id);
  // Yellows, limes and cyans are light; blues, purples and reds are dark.
  return (h > 40 && h < 200) ? THEME.tag.textDark : THEME.tag.textLight;
}

// ---- palette remap ------------------------------------------------------------------------------

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export type GroundKind = 'grass' | 'earth';

/** What each original tileset colour becomes, for one kind of ground tile. */
export function groundRule(kind: GroundKind): (r: number, g: number, b: number) => [number, number, number] {
  const R = THEME.remap;
  const grass = (r: number, g: number, b: number): [number, number, number] => {
    const [h, s, l] = rgbToHsl(r, g, b);
    const G = R.grass;
    if (s >= 0.16 && h >= 60 && h <= 200) return hslToRgb(G.hue + (h - 130) * G.hueSpread, Math.min(G.satMax, s * G.satScale), Math.min(G.lightMax, l * G.lightScale));
    if (s > 0.3 && h >= 30 && h < 60) return hslToRgb(h, Math.min(0.9, s * 1.4), l * 1.05);
    return hslToRgb(G.detailHue, G.detailSat, l * G.detailLight);
  };
  if (kind === 'grass') return grass;
  return (r, g, b) => {
    const [h, s, l] = rgbToHsl(r, g, b);
    const E = R.earth;
    if (s < 0.16) return hslToRgb(E.greyHue, E.greySat, l * E.greyLight);
    if (h >= 60 && h <= 200) return grass(r, g, b);
    return hslToRgb(h + E.hueShift, Math.min(E.satMax, s * E.satScale), Math.min(0.85, l * E.lightScale));
  };
}

/** A recoloured copy of an image (each distinct colour is converted once). */
export function recolour(img: CanvasImageSource & { width: number; height: number }, fn: (r: number, g: number, b: number) => [number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  const memo = new Map<number, [number, number, number]>();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const key = (px[i]! << 16) | (px[i + 1]! << 8) | px[i + 2]!;
    let out = memo.get(key);
    if (!out) memo.set(key, (out = fn(px[i]!, px[i + 1]!, px[i + 2]!)));
    px[i] = out[0];
    px[i + 1] = out[1];
    px[i + 2] = out[2];
  }
  g.putImageData(data, 0, 0);
  return c;
}
