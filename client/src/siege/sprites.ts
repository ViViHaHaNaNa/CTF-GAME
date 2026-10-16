import { PROP_FILES } from '@siege/shared';
import { ASSET_ROOT } from './config.ts';

// Sprite sheets from the art pack. Sheets are horizontal strips; the number after "Sheet" in the file
// name is the frame count, so frame width = sheet width / count.

const FILES = {
  ground: 'Tiles/Background_Green_TileSet.png',

  // Survivors are layered: body (no hands) + weapon (with hands) + optional helmet.
  body: 'Character/Main/Idle/Character_side_idle_no-hands-Sheet6.png',
  bodyRun: 'Character/Main/Run/Character_side_run_no-hands-Sheet6.png',
  bodyDeath: 'Character/Main/Death/Character_side_death1-Sheet6.png',
  pistol: 'Character/Guns/Pistol/Pistol_side_idle-and-run-Sheet6.png',
  gun: 'Character/Guns/Gun/Gun_side_idle-and-run-Sheet6.png',
  shotgun: 'Character/Guns/Shotgun/Shotgun_side_idle-and-run-Sheet6.png',
  bat: 'Character/Bat/Bat_side_idle-and-run-Sheet6.png',
  helmet: 'Character/Helmet/Helmet_side_Idle-and-Run-Sheet6.png',
  fire: 'Character/Guns/Fire/Fire_side-Sheet3.png',

  zSmallWalk: 'Enemies/Zombie_Small/Zombie_Small_Side_Walk-Sheet6.png',
  zSmallAttack: 'Enemies/Zombie_Small/Zombie_Small_Side_First-Attack-Sheet4.png',
  zSmallDeath: 'Enemies/Zombie_Small/Zombie_Small_Side_First-Death-Sheet6.png',
  zBigWalk: 'Enemies/Zombie_Big/Zombie_Big_Side_Walk-Sheet8.png',
  zBigAttack: 'Enemies/Zombie_Big/Zombie_Big_Side_First-Attack-Sheet8.png',
  zBigDeath: 'Enemies/Zombie_Big/Zombie_Big_Side_First-Death-Sheet7.png',
  zAxeWalk: 'Enemies/Zombie_Axe/Zombie_Axe_Side_Walk-Sheet8.png',
  zAxeAttack: 'Enemies/Zombie_Axe/Zombie_Axe_Side_First-Attack-Sheet7.png',
  zAxeDeath: 'Enemies/Zombie_Axe/Zombie_Axe_Side_First-Death-Sheet6.png',

  wallWoodH: 'Objects/Buildable/Wooden/Wooden-wall_Horizontal.png',
  wallWoodV: 'Objects/Buildable/Wooden/Wooden-wall_Vertical.png',
  wallReinH: 'Objects/Buildable/Reinforced/Reinforced_wooden-wall_Horizontal.png',
  wallReinV: 'Objects/Buildable/Reinforced/Reinforced_wooden-wall_Vertical.png',
  debris: 'Objects/Gray-brick_Debris.png',
  bricks: 'Objects/Buildings/Brick-wall_1_Lying.png',
  crate: 'Objects/Pallet_1.png',

  containerGray: 'Objects/Container/Container_3_Gray_Horizontal.png',
  containerRed: 'Objects/Container/Container_7_Red_Horizontal.png',
  containerGreen: 'Objects/Container/Container_11_Green_Horizontal.png',
  antenna1: 'Objects/Buildings/Antenna_1.png',
  antenna2: 'Objects/Buildings/Antenna_2.png',
  hvac: 'Objects/Buildings/HVAC.png',
  barrelRust: 'Objects/Barrel_rust_red_1.png',
  barrelBlue: 'Objects/Barrel_blue_1.png',
  pallet: 'Objects/Pallet_1.png',
  cardboard: 'Objects/Cardboard_1.png',

  crateGreen: 'Objects/Pickable/Ammo-crate_Green.png',
  crateBlue: 'Objects/Pickable/Ammo-crate_Blue.png',
  crateRed: 'Objects/Pickable/Ammo-crate_Red.png',

  // Weather
  rainSplash: 'Objects/Nature/Flowers_Mashrooms_Other-nature-stuff/Puddles-And-Water-Anim/Animations/Rain-drop-splash_1_Small-Sheet5.png',
  rainSplashBig: 'Objects/Nature/Flowers_Mashrooms_Other-nature-stuff/Puddles-And-Water-Anim/Animations/Rain-drop-splash_2_Big-Sheet5.png',
  puddleSplash: 'Objects/Nature/Flowers_Mashrooms_Other-nature-stuff/Puddles-And-Water-Anim/Animations/Puddle-Splash_3_Normal-Sheet4.png',
} as const;

/** Grave sprites live in their own folder so they can be replaced without touching the pack. */
const GRAVES = ['/game-assets/graveyard/grave_1.png', '/game-assets/graveyard/grave_2.png', '/game-assets/graveyard/grave_3.png', '/game-assets/graveyard/grave_4.png'];

export type SpriteKey = keyof typeof FILES;

export interface Sheet {
  img: HTMLImageElement;
  frames: number;
  fw: number;
  fh: number;
}

export interface Sprites extends Record<SpriteKey, Sheet> {
  /** Scenery images by index into PROP_FILES. */
  props: HTMLImageElement[];
  graves: HTMLImageElement[];
}

/**
 * Where each layer sits relative to the body frame's top-left (body frame is 10x16).
 * Worked out from the pack's hand positions; tweak here if a weapon looks off.
 */
export const LAYER_OFFSET = {
  pistol: { x: 4, y: 6 },
  gun: { x: -1, y: 6 },
  shotgun: { x: -1, y: 7 },
  bat: { x: -5, y: 3 },
  helmet: { x: 0, y: 0 },
  /** Muzzle flash, relative to the weapon frame. */
  fire: { pistol: { x: 7, y: 0 }, gun: { x: 14, y: 1 }, shotgun: { x: 13, y: 0 } },
} as const;

const url = (file: string) => ASSET_ROOT + file.split('/').map(encodeURIComponent).join('/');

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Missing sprite ${src}`));
    img.src = src;
  });
}

export async function loadSprites(onProgress?: (done: number, total: number) => void): Promise<Sprites> {
  const named = Object.entries(FILES) as [SpriteKey, string][];
  const total = named.length + PROP_FILES.length + GRAVES.length;
  let done = 0;
  const tick = <T>(p: Promise<T>) => p.then((v) => (onProgress?.(++done, total), v));
  const [sheets, props, graves] = await Promise.all([
    Promise.all(
      named.map(([key, file]) =>
        tick(loadImage(url(file))).then((img): [SpriteKey, Sheet] => {
          const frames = Number(/Sheet(\d+)/.exec(file)?.[1] ?? 1);
          return [key, { img, frames, fw: Math.floor(img.width / frames), fh: img.height }];
        }),
      ),
    ),
    Promise.all(PROP_FILES.map((f) => tick(loadImage(url(f))))),
    Promise.all(GRAVES.map((g) => tick(loadImage(g)))),
  ]);
  return { ...(Object.fromEntries(sheets) as Record<SpriteKey, Sheet>), props, graves };
}

/** Draw one frame of a sheet. `flip` mirrors it horizontally around its own centre. */
export function drawFrame(g: CanvasRenderingContext2D, s: Sheet, frame: number, x: number, y: number, flip = false) {
  const f = ((frame % s.frames) + s.frames) % s.frames;
  if (!flip) {
    g.drawImage(s.img, f * s.fw, 0, s.fw, s.fh, Math.round(x), Math.round(y), s.fw, s.fh);
    return;
  }
  g.save();
  g.translate(Math.round(x) + s.fw, Math.round(y));
  g.scale(-1, 1);
  g.drawImage(s.img, f * s.fw, 0, s.fw, s.fh, 0, 0, s.fw, s.fh);
  g.restore();
}
