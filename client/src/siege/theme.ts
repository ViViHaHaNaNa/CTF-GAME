// The canvas side of the theme. Every value comes from the CSS variables in client/src/theme.css
// (the one file that defines the whole look); this module just reads them once at start-up and adds
// the colour helpers the renderer needs.

const root = getComputedStyle(document.documentElement);

/** A theme variable as text (a missing one is a mistake in theme.css: say so loudly). */
function css(name: string): string {
  const v = root.getPropertyValue(name).trim();
  if (!v) console.error(`theme.css is missing ${name}`);
  return v;
}
const num = (name: string) => Number(css(name));
/** "r, g, b" triplet. */
const rgb = (name: string) => css(name).split(',').map((x) => Number(x.trim())) as [number, number, number];

/** Fonts for text drawn on the canvas (bundled via theme.css @font-face; no internet needed). */
export const FONT = css('--font');
export const FONT_MONO = css('--font-mono');
export const FONT_DISPLAY = css('--font-display');

/** Load the bundled fonts before drawing text on a canvas (canvas text doesn't wait for them). */
export async function loadFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`16px 'Siege Display'`),
      document.fonts.load(`16px 'Siege Sans'`),
      document.fonts.load(`700 16px 'Siege Sans'`),
      document.fonts.load(`16px 'Siege Mono'`),
    ]);
  } catch {
    /* fall back to system fonts */
  }
}

export const THEME = {
  /** Behind the map edges. */
  void: css('--map-void'),

  /**
   * Palette remap of the pack's Green ground tileset, applied at load time (the files are untouched).
   * Each tile type has its own rule. Hues in degrees, saturation/lightness 0..1.
   */
  remap: {
    /** Grass tiles: greens get vivid; grey detail pixels become deep green; flowers get brighter. */
    grass: {
      hue: num('--map-grass-hue'),
      hueSpread: num('--map-grass-hue-spread'),
      satScale: num('--map-grass-sat-scale'),
      satMax: num('--map-grass-sat-max'),
      lightScale: num('--map-grass-light-scale'),
      lightMax: num('--map-grass-light-max'),
      detailHue: num('--map-grass-detail-hue'),
      detailSat: num('--map-grass-detail-sat'),
      detailLight: num('--map-grass-detail-light'),
    },
    /** Dirt and paving: warmer and richer. */
    earth: {
      hueShift: num('--map-earth-hue-shift'),
      satScale: num('--map-earth-sat-scale'),
      satMax: num('--map-earth-sat-max'),
      lightScale: num('--map-earth-light-scale'),
      greyHue: num('--map-earth-grey-hue'),
      greySat: num('--map-earth-grey-sat'),
      greyLight: num('--map-earth-grey-light'),
    },
  },

  /** Streets: generated asphalt texture (base colour with light and dark specks). */
  asphalt: { base: css('--map-asphalt'), light: css('--map-asphalt-light'), dark: css('--map-asphalt-dark'), lightShare: num('--map-asphalt-speck'), darkShare: num('--map-asphalt-speck') },
  alleyShade: css('--map-alley-shade'),
  laneStripe: css('--map-lane'),
  kerb: css('--map-kerb'),

  /** Soft shadows (sun from the top left). */
  shadow: css('--map-shadow'),
  shadowOffset: { x: num('--map-shadow-x'), y: num('--map-shadow-y') },

  /** Graveyard atmosphere. */
  ember: rgb('--map-ember'),
  emberHot: rgb('--map-ember-hot'),
  fog: rgb('--map-fog'),
  graveWarn: rgb('--map-grave-warn'),
  graveWave: rgb('--map-grave-wave'),

  /** Rain: one shower every `every` seconds, lasting `lasts`, fading in/out over `fade`. */
  rain: css('--map-rain'),
  rainTint: css('--map-rain-tint'),
  puddle: css('--map-puddle'),
  puddleShine: css('--map-puddle-shine'),
  weather: { every: num('--map-rain-every'), lasts: num('--map-rain-lasts'), fade: num('--map-rain-fade'), drops: num('--map-rain-drops') },

  /** Base banners: each base gets its own hue from its player id. */
  banner: { sat: num('--map-banner-sat'), light: num('--map-banner-light') },
  /** Your own base's tag outline (and minimap square). */
  mine: css('--map-mine'),

  tag: {
    font: num('--map-tag-weight'),
    size: num('--map-tag-size'),
    sizeSmall: num('--map-tag-size-small'),
    padX: num('--map-tag-pad-x'),
    padY: num('--map-tag-pad-y'),
    textDark: css('--map-tag-dark'),
    textLight: css('--map-tag-light'),
    raid: css('--map-tag-raid'),
    shield: css('--map-tag-shield'),
    outline: css('--map-tag-outline'),
    crateSize: num('--map-crate-tag-size'),
    crateWeight: num('--map-crate-tag-weight'),
  },

  crate: { rare: css('--map-crate-rare'), epic: css('--map-crate-epic'), legendary: css('--map-crate-legendary') },

  hp: { good: css('--map-hp-good'), low: css('--map-hp-low'), unit: css('--map-hp-unit'), back: css('--map-hp-back') },
  tracer: css('--map-tracer'),
  dirtPuff: rgb('--map-dirt-puff'),
  deploy: { fill: rgb('--map-deploy'), edge: css('--map-deploy-edge') },
  pick: rgb('--map-pick'),
  slotOpen: css('--map-slot-open'),
  slotLocked: css('--map-slot-locked'),
  levelPip: { back: css('--map-pip-back'), on: css('--map-pip-on') },
  flagPole: css('--map-flag-pole'),
  raiderTint: css('--map-raider-tint'),
  unitShadow: css('--map-unit-shadow'),
  ruinFade: css('--map-ruin-fade'),

  minimap: {
    ground: rgb('--map-mini-ground'),
    street: rgb('--map-mini-street'),
    mud: rgb('--map-mini-mud'),
    alley: rgb('--map-mini-alley'),
    empty: css('--map-mini-empty'),
    view: css('--map-mini-view'),
    waveDim: css('--map-mini-wave-dim'),
    flash: css('--map-mini-flash'),
  },
};

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
