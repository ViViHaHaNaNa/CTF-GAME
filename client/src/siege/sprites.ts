import { ASSET_ROOT } from './config.ts';

// Sprite sheets from the art pack. Sheets are horizontal strips; the number after "Sheet" in the file
// name is the frame count, so frame width = sheet width / count.

const FILES = {
  ground: 'Tiles/Background_Bleak-Yellow_TileSet.png',

  // Survivors are layered: body (no hands) + weapon (with hands) + optional helmet.
  body: 'Character/Main/Idle/Character_side_idle_no-hands-Sheet6.png',
  pistol: 'Character/Guns/Pistol/Pistol_side_idle-and-run-Sheet6.png',
  gun: 'Character/Guns/Gun/Gun_side_idle-and-run-Sheet6.png',
  shotgun: 'Character/Guns/Shotgun/Shotgun_side_idle-and-run-Sheet6.png',
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

  containerGray: 'Objects/Container/Container_3_Gray_Horizontal.png',
  containerRed: 'Objects/Container/Container_7_Red_Horizontal.png',
  containerGreen: 'Objects/Container/Container_11_Green_Horizontal.png',
  antenna1: 'Objects/Buildings/Antenna_1.png',
  antenna2: 'Objects/Buildings/Antenna_2.png',
  hvac: 'Objects/Buildings/HVAC.png',
  barrelRust: 'Objects/Barrel_rust_red_1.png',
  barrelBlue: 'Objects/Barrel_blue_1.png',
  pallet: 'Objects/Pallet_1.png',

  tires: 'Objects/2-Tires_Grass_Bleak-Yellow.png',
  tree1: 'Objects/Nature/Bleak-Yellow/Tree_1_Spruce_Bleak-Yellow.png',
  tree3: 'Objects/Nature/Bleak-Yellow/Tree_3_Normal_Bleak-Yellow.png',
  tree9: 'Objects/Nature/Bleak-Yellow/Tree_9_Small-oak_Bleak-Yellow.png',
  bush1: 'Objects/Nature/Bleak-Yellow/Bush_1_Bleak-Yellow.png',
  bush2: 'Objects/Nature/Bleak-Yellow/Bush_2_Bleak-Yellow.png',
  grass1: 'Objects/Nature/Bleak-Yellow/Grass_1_Bleak-Yellow.png',
  grass2: 'Objects/Nature/Bleak-Yellow/Grass_2_Bleak-Yellow.png',
  rock: 'Objects/Nature/Bleak-Yellow/Rocks/Rock-grass_Bleak-Yellow.png',
  cardboard: 'Objects/Cardboard_1.png',
} as const;

export type SpriteKey = keyof typeof FILES;

export interface Sheet {
  img: HTMLImageElement;
  frames: number;
  fw: number;
  fh: number;
}

export type Sprites = Record<SpriteKey, Sheet>;

/**
 * Where each layer sits relative to the body frame's top-left (body frame is 10x16).
 * Worked out from the pack's hand positions; tweak here if a weapon looks off.
 */
export const LAYER_OFFSET = {
  pistol: { x: 4, y: 6 },
  gun: { x: -1, y: 6 },
  shotgun: { x: -1, y: 7 },
  helmet: { x: 0, y: 0 },
  /** Muzzle flash, relative to the weapon frame. */
  fire: { pistol: { x: 7, y: 0 }, gun: { x: 14, y: 1 }, shotgun: { x: 13, y: 0 } },
} as const;

export async function loadSprites(): Promise<Sprites> {
  const entries = await Promise.all(
    (Object.entries(FILES) as [SpriteKey, string][]).map(
      ([key, file]) =>
        new Promise<[SpriteKey, Sheet]>((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const frames = Number(/Sheet(\d+)/.exec(file)?.[1] ?? 1);
            resolve([key, { img, frames, fw: Math.floor(img.width / frames), fh: img.height }]);
          };
          img.onerror = () => reject(new Error(`Missing sprite ${file}`));
          img.src = ASSET_ROOT + file.split('/').map(encodeURIComponent).join('/');
        }),
    ),
  );
  return Object.fromEntries(entries) as Sprites;
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
