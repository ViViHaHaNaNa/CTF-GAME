import { LAYER_OFFSET, drawFrame, loadSheet, type Sheet } from './sprites.ts';
import { themeVar } from './theme.ts';

// The title screen's attract mode: survivors hold a ruined street while zombies shamble in from the
// right. A small self-contained simulation with randomised timing (so it never reads as a loop),
// drawn at native pixel size. The backdrop is composed once from the art pack.

const P = 'Character/';
const Z = 'Enemies/';
const ART = {
  body: `${P}Main/Idle/Character_side_idle_no-hands-Sheet6.png`,
  helmet: `${P}Helmet/Helmet_side_Idle-and-Run-Sheet6.png`,
  pistol: `${P}Guns/Pistol/Pistol_side_idle-and-run-Sheet6.png`,
  pistolShoot: `${P}Guns/Pistol/Pistol_side_shoot-Sheet3.png`,
  gun: `${P}Guns/Gun/Gun_side_idle-and-run-Sheet6.png`,
  gunShoot: `${P}Guns/Gun/Gun_side_shoot-Sheet3.png`,
  shotgun: `${P}Guns/Shotgun/Shotgun_side_idle-and-run-Sheet6.png`,
  shotgunShoot: `${P}Guns/Shotgun/Shotgun_side_shoot-Sheet3.png`,
  bat: `${P}Bat/Bat_side_idle-and-run-Sheet6.png`,
  batSwing: `${P}Bat/Bat_side_attack-Sheet4.png`,
  fire: `${P}Guns/Fire/Fire_side-Sheet3.png`,
  bulletPistol: `${P}Guns/Bullets/Pistol-bullet_Bullet.png`,
  bulletGun: `${P}Guns/Bullets/Gun-bullet_Bullet.png`,
  bulletShotgun: `${P}Guns/Bullets/Shotgun-bullet.png`,
  smallWalk: `${Z}Zombie_Small/Zombie_Small_Side-left_Walk-Sheet6.png`,
  smallAttack: `${Z}Zombie_Small/Zombie_Small_Side-left_First-Attack-Sheet4.png`,
  smallDeath: `${Z}Zombie_Small/Zombie_Small_Side-left_First-Death-Sheet6.png`,
  bigWalk: `${Z}Zombie_Big/Zombie_Big_Side-left_Walk-Sheet8.png`,
  bigAttack: `${Z}Zombie_Big/Zombie_Big_Side-left_First-Attack-Sheet8.png`,
  bigDeath: `${Z}Zombie_Big/Zombie_Big_Side-left_First-Death-Sheet7.png`,
  axeWalk: `${Z}Zombie_Axe/Zombie_Axe_Side-left_Walk-Sheet8.png`,
  axeAttack: `${Z}Zombie_Axe/Zombie_Axe_Side-left_First-Attack-Sheet7.png`,
  axeDeath: `${Z}Zombie_Axe/Zombie_Axe_Side-left_First-Death-Sheet6.png`,
  // Backdrop
  bldgBeige: 'Tiles/Buildings/Buildings_beige_TileSet.png',
  bldgGray: 'Tiles/Buildings/Buildings_gray_TileSet.png',
  bldgWhite: 'Tiles/Buildings/Buildings_white_TileSet.png',
  bldgDark: 'Tiles/Buildings/Buildings_dark_TileSet.png',
  door1: 'Objects/Buildings/Door_3_Boarded-up_Beige.png',
  door2: 'Objects/Buildings/Door_5_Rusty_Metal.png',
  door3: 'Objects/Buildings/Door_2_Ajar_Beige.png',
  awningOrange: 'Objects/Buildings/Awning_orange_2.png',
  awningBlue: 'Objects/Buildings/Awning_blue_2.png',
  posters: 'Objects/Buildings/layered-posters_1_For-ground-and-walls.png',
  holes: 'Objects/Buildings/Destroyed-wall_not-corner.png',
  bricks: 'Objects/Buildings/Brick-wall_1_Lying.png',
  container: 'Objects/Container/Container_8_Red_Horizontal_Overgrown_Green.png',
  car1: 'Objects/Vehicles/Rust/Car_4_Rust/Car_4_Rust_Green.png',
  car2: 'Objects/Vehicles/Rust/Car_6_Rust_Scrap/Car_6_Rust_Orange_Scrap.png',
  deadTree: 'Objects/Nature/Flowers_Mashrooms_Other-nature-stuff/Tree_4_Dry_Green.png',
  light: 'Objects/Street-Light_4_Side_Overgrown_Green.png',
  barrel: 'Objects/Barrel_rust_red_1.png',
  barrel2: 'Objects/Barrel_blue_1.png',
  cone: 'Objects/Traffic-cone.png',
  tires: 'Objects/Tire_1.png',
} as const;

export type TitleArt = Record<keyof typeof ART, Sheet>;

export async function loadTitleArt(): Promise<TitleArt> {
  const entries = await Promise.all(Object.entries(ART).map(async ([k, f]) => [k, await loadSheet(f)] as const));
  return Object.fromEntries(entries) as TitleArt;
}

type Weapon = 'pistol' | 'gun' | 'shotgun' | 'bat';
type ZKind = 'small' | 'big' | 'axe';

interface Survivor {
  weapon: Weapon;
  x: number;
  helmet: boolean;
  cooldown: number;
  /** Seconds left of the current shot/swing animation. */
  acting: number;
  phase: number;
  /** A bat swing that hasn't connected yet. */
  swingPending: boolean;
}

interface Zombie {
  kind: ZKind;
  boss: boolean;
  x: number;
  /** Small depth offset so they don't stand in a perfect line. */
  dy: number;
  speed: number;
  hp: number;
  maxHp: number;
  state: 'walk' | 'attack' | 'die';
  t: number;
  flash: number;
  seed: number;
}

interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dmg: number;
  img: HTMLImageElement;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

const STATS: Record<Weapon, { cooldown: [number, number]; range: number; dmg: number; act: number }> = {
  pistol: { cooldown: [0.5, 1.0], range: 0.55, dmg: 1, act: 0.18 },
  gun: { cooldown: [0.8, 1.3], range: 0.72, dmg: 2, act: 0.18 },
  shotgun: { cooldown: [1.2, 1.9], range: 0.3, dmg: 2, act: 0.22 },
  bat: { cooldown: [0.35, 0.5], range: 15, dmg: 3, act: 0.36 },
};
/** Gun ranges above are a share of the scene width (so portrait and landscape both get a fight mid-street). */
const reach = (weapon: Weapon, sceneW: number) => (weapon === 'bat' ? STATS.bat.range : STATS[weapon].range * sceneW);

const ZSTATS: Record<ZKind, { speed: [number, number]; hp: number; weight: number }> = {
  small: { speed: [14, 20], hp: 4, weight: 0.55 },
  axe: { speed: [10, 14], hp: 7, weight: 0.3 },
  big: { speed: [6, 9], hp: 12, weight: 0.15 },
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class AttractScene {
  w = 0;
  h = 0;
  private backdrop: HTMLCanvasElement | null = null;
  private survivors: Survivor[] = [];
  private zombies: Zombie[] = [];
  private bullets: Bullet[] = [];
  private particles: Particle[] = [];
  private nextSpawn = 1;
  private burst = 0;
  private nextBoss = rand(18, 30);
  private shake = 0;
  private shakeMag = 0;
  private time = 0;
  private flashImg = document.createElement('canvas');
  private colors = {
    blood: themeVar('--title-blood'),
    flash: themeVar('--title-flash'),
    ember: themeVar('--title-ember'),
  };

  constructor(private readonly art: TitleArt) {}

  /** Lay the scene out for a new size (rebuilds the backdrop). */
  resize(w: number, h: number) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.backdrop = this.buildBackdrop();
    const gap = w < 200 ? 15 : 17;
    const x0 = w < 200 ? 6 : 12;
    this.survivors = (['gun', 'pistol', 'shotgun', 'bat'] as Weapon[]).map((weapon, i) => ({
      weapon,
      x: x0 + i * gap,
      helmet: weapon === 'shotgun' || weapon === 'bat',
      cooldown: rand(0.2, 1.5),
      acting: 0,
      phase: Math.random() * 6,
      swingPending: false,
    }));
    this.zombies = [];
    this.bullets = [];
    this.particles = [];
  }

  /** Feet of everyone standing in the street. */
  private get footY() {
    return this.h - 5;
  }

  private get lineX() {
    return this.survivors[this.survivors.length - 1]!.x + 14;
  }

  // ---- simulation ------------------------------------------------------------------------------------

  update(dt: number) {
    this.time += dt;
    this.spawn(dt);
    for (const s of this.survivors) this.act(s, dt);
    for (const z of this.zombies) {
      z.flash = Math.max(0, z.flash - dt);
      z.t += dt;
      if (z.state === 'walk') {
        z.x -= z.speed * dt;
        if (z.x <= this.lineX + (z.boss ? 10 : 0)) {
          z.state = 'attack';
          z.t = 0;
        }
      }
    }
    this.zombies = this.zombies.filter((z) => !(z.state === 'die' && z.t > 1.4) && z.x > -40);
    for (const b of this.bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      const hit = this.zombies.find((z) => z.state !== 'die' && b.x >= this.hitLeft(z) && b.x <= this.hitLeft(z) + this.hitWidth(z) && b.y >= this.footY - this.hitHeight(z) && b.y <= this.footY + 2);
      if (hit) {
        this.damage(hit, b.dmg, b.x, b.y);
        b.x = Infinity;
      }
    }
    this.bullets = this.bullets.filter((b) => b.x < this.w + 10);
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 140 * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    // Drifting embers over the whole scene.
    if (Math.random() < dt * 3) this.particles.push({ x: rand(0, this.w), y: this.h, vx: rand(-6, 6), vy: rand(-22, -12), life: rand(2, 4), max: 4, color: this.colors.ember, size: 1 });
    for (const p of this.particles) if (p.color === this.colors.ember) p.vy -= 140 * dt; // embers float, they don't fall
    this.shake = Math.max(0, this.shake - dt);
  }

  private spawn(dt: number) {
    this.nextBoss -= dt;
    const bossAlive = this.zombies.some((z) => z.boss && z.state !== 'die');
    if (this.nextBoss <= 0 && !bossAlive) {
      this.add('big', true);
      this.nextBoss = rand(22, 40);
    }
    this.nextSpawn -= dt;
    if (this.nextSpawn > 0) return;
    if (this.zombies.filter((z) => z.state !== 'die').length < (bossAlive ? 4 : 8)) {
      const r = Math.random();
      const kind: ZKind = r < ZSTATS.small.weight ? 'small' : r < ZSTATS.small.weight + ZSTATS.axe.weight ? 'axe' : 'big';
      this.add(kind, false);
    }
    if (this.burst > 0) {
      this.burst--;
      this.nextSpawn = rand(0.25, 0.6);
    } else {
      if (Math.random() < 0.12) this.burst = Math.floor(rand(2, 5));
      this.nextSpawn = rand(0.6, 2.4) * (bossAlive ? 1.8 : 1);
    }
  }

  private add(kind: ZKind, boss: boolean) {
    const st = ZSTATS[kind];
    const hp = boss ? 40 : st.hp;
    this.zombies.push({ kind, boss, x: this.w + rand(4, 16), dy: boss ? 0 : Math.round(rand(-2, 2)), speed: rand(...st.speed) * (boss ? 0.7 : 1), hp, maxHp: hp, state: 'walk', t: Math.random() * 3, flash: 0, seed: Math.random() });
  }

  private sheets(z: Zombie) {
    const a = this.art;
    return z.kind === 'small' ? [a.smallWalk, a.smallAttack, a.smallDeath] : z.kind === 'axe' ? [a.axeWalk, a.axeAttack, a.axeDeath] : [a.bigWalk, a.bigAttack, a.bigDeath];
  }

  private scale(z: Zombie) {
    return z.boss ? 2 : 1;
  }

  private hitWidth(z: Zombie) {
    return (this.sheets(z)[0]!.fw - 6) * this.scale(z);
  }

  private hitHeight(z: Zombie) {
    return (this.sheets(z)[0]!.fh - 2) * this.scale(z);
  }

  private hitLeft(z: Zombie) {
    return z.x - this.hitWidth(z) / 2;
  }

  private damage(z: Zombie, dmg: number, x: number, y: number) {
    z.hp -= dmg;
    z.flash = 0.07;
    for (let i = 0; i < 3 + dmg; i++) this.particles.push({ x, y, vx: rand(10, 50), vy: rand(-50, -10), life: rand(0.25, 0.5), max: 0.5, color: this.colors.blood, size: 1 });
    if (z.hp <= 0 && z.state !== 'die') {
      z.state = 'die';
      z.t = 0;
      if (z.boss) {
        this.shake = 0.5;
        this.shakeMag = 3;
        for (let i = 0; i < 30; i++) this.particles.push({ x: z.x, y: this.footY - 20, vx: rand(-60, 80), vy: rand(-90, -20), life: rand(0.4, 0.9), max: 0.9, color: this.colors.blood, size: 2 });
      }
    }
  }

  private act(s: Survivor, dt: number) {
    s.cooldown -= dt;
    s.acting = Math.max(0, s.acting - dt);
    const st = STATS[s.weapon];
    // The bat connects partway through the swing.
    if (s.swingPending && s.acting <= st.act * 0.6) {
      s.swingPending = false;
      for (const z of this.zombies) if (z.state !== 'die' && z.x - s.x < reach('bat', this.w) + (z.boss ? 12 : 0)) this.damage(z, st.dmg, z.x - 4, this.footY - 10);
    }
    const alive = this.zombies.filter((z) => z.state !== 'die').sort((a, b) => a.x - b.x);
    const target = alive.find((z) => z.x - s.x < reach(s.weapon, this.w) && z.x > s.x);
    if (!target || s.cooldown > 0) return;
    s.cooldown = rand(...st.cooldown);
    s.acting = st.act;
    if (s.weapon === 'bat') {
      s.swingPending = true;
      return;
    }
    const muzzleY = this.footY - 16 + 3 + LAYER_OFFSET[s.weapon].y + 1;
    const mx = s.x + 9 + LAYER_OFFSET[s.weapon].x + LAYER_OFFSET.fire[s.weapon].x + 4;
    const img = s.weapon === 'pistol' ? this.art.bulletPistol.img : s.weapon === 'gun' ? this.art.bulletGun.img : this.art.bulletShotgun.img;
    const pellets = s.weapon === 'shotgun' ? 3 : 1;
    for (let i = 0; i < pellets; i++) this.bullets.push({ x: mx, y: muzzleY, vx: 260, vy: pellets > 1 ? (i - 1) * 18 : 0, dmg: st.dmg / (pellets > 1 ? 1.5 : 1), img });
    if (s.weapon === 'shotgun') {
      this.shake = 0.12;
      this.shakeMag = 1;
    }
  }

  // ---- drawing ------------------------------------------------------------------------------------------

  /** Current screen-shake offset (apply to the whole screen, not just the scene). */
  shakeOffset(): [number, number] {
    if (this.shake <= 0) return [0, 0];
    const m = this.shakeMag;
    return [Math.round(rand(-m, m)), Math.round(rand(-m, m))];
  }

  draw(g: CanvasRenderingContext2D, ox: number, oy: number) {
    if (!this.backdrop) return;
    g.save();
    g.beginPath();
    g.rect(ox, oy, this.w, this.h);
    g.clip();
    g.drawImage(this.backdrop, ox, oy);
    const items: { y: number; draw: () => void }[] = [];
    for (const s of this.survivors) items.push({ y: this.footY, draw: () => this.drawSurvivor(g, s, ox, oy) });
    for (const z of this.zombies) items.push({ y: this.footY + z.dy + (z.state === 'die' ? -5 : 0), draw: () => this.drawZombie(g, z, ox, oy) });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    for (const b of this.bullets) g.drawImage(b.img, Math.round(ox + b.x), Math.round(oy + b.y));
    for (const p of this.particles) {
      g.globalAlpha = Math.min(1, p.life / (p.max * 0.5));
      g.fillStyle = p.color;
      g.fillRect(Math.round(ox + p.x), Math.round(oy + p.y), p.size, p.size);
    }
    g.globalAlpha = 1;
    g.restore();
  }

  private drawSurvivor(g: CanvasRenderingContext2D, s: Survivor, ox: number, oy: number) {
    const a = this.art;
    const x = Math.round(ox + s.x);
    const y = Math.round(oy + this.footY - 16);
    const idle = Math.floor(this.time * 8 + s.phase) % 6;
    g.fillStyle = 'rgba(0, 0, 0, 0.3)';
    g.fillRect(x - 1, y + 15, 12, 2);
    drawFrame(g, a.body, idle, x, y);
    if (s.helmet) drawFrame(g, a.helmet, idle, x + LAYER_OFFSET.helmet.x, y + LAYER_OFFSET.helmet.y);
    const st = STATS[s.weapon];
    const t = 1 - s.acting / st.act; // 0..1 through the action
    if (s.weapon === 'bat') {
      if (s.acting > 0) drawFrame(g, a.batSwing, Math.min(3, Math.floor(t * 4)), x - 9, y);
      else drawFrame(g, a.bat, idle, x + LAYER_OFFSET.bat.x, y + LAYER_OFFSET.bat.y);
      return;
    }
    const off = LAYER_OFFSET[s.weapon];
    if (s.acting > 0) {
      const sheet = s.weapon === 'pistol' ? a.pistolShoot : s.weapon === 'gun' ? a.gunShoot : a.shotgunShoot;
      const f = Math.min(2, Math.floor(t * 3));
      drawFrame(g, sheet, f, x + off.x, y + off.y);
      if (f < 2) {
        const fo = LAYER_OFFSET.fire[s.weapon];
        drawFrame(g, a.fire, f, x + off.x + fo.x + 2, y + off.y + fo.y);
      }
    } else {
      const sheet = s.weapon === 'pistol' ? a.pistol : s.weapon === 'gun' ? a.gun : a.shotgun;
      drawFrame(g, sheet, idle, x + off.x, y + off.y);
    }
  }

  private drawZombie(g: CanvasRenderingContext2D, z: Zombie, ox: number, oy: number) {
    const [walk, attack, death] = this.sheets(z) as [Sheet, Sheet, Sheet];
    const k = this.scale(z);
    let sheet = walk;
    let frame = Math.floor(z.t * (z.boss ? 6 : 9) + z.seed * 8);
    if (z.state === 'attack') {
      sheet = attack;
      frame = Math.floor(z.t * 8);
    } else if (z.state === 'die') {
      sheet = death;
      frame = Math.min(death.frames - 1, Math.floor(z.t * 11));
    }
    const w = sheet.fw * k;
    const h = sheet.fh * k;
    const x = Math.round(ox + z.x - w / 2);
    const y = Math.round(oy + this.footY + z.dy - h + 1);
    if (z.state === 'die') g.globalAlpha = Math.max(0, Math.min(1, 1.4 - z.t));
    g.fillStyle = 'rgba(0, 0, 0, 0.3)';
    g.fillRect(x + 2 * k, y + h - 1, w - 4 * k, 2);
    const f = ((frame % sheet.frames) + sheet.frames) % sheet.frames;
    g.drawImage(sheet.img, f * sheet.fw, 0, sheet.fw, sheet.fh, x, y, w, h);
    if (z.flash > 0) {
      // White hit flash: the frame's silhouette in white.
      const c = this.flashImg;
      // Resizing a canvas reallocates it: only do that when the frame size changes.
      if (c.width !== sheet.fw || c.height !== sheet.fh) {
        c.width = sheet.fw;
        c.height = sheet.fh;
      }
      const fg = c.getContext('2d')!;
      fg.clearRect(0, 0, c.width, c.height);
      fg.drawImage(sheet.img, f * sheet.fw, 0, sheet.fw, sheet.fh, 0, 0, sheet.fw, sheet.fh);
      fg.globalCompositeOperation = 'source-in';
      fg.fillStyle = this.colors.flash;
      fg.fillRect(0, 0, c.width, c.height);
      fg.globalCompositeOperation = 'source-over';
      g.drawImage(c, x, y, w, h);
    }
    g.globalAlpha = 1;
    if (z.boss && z.state !== 'die') {
      g.fillStyle = '#000000';
      g.fillRect(x + 2, y - 5, w - 4, 3);
      g.fillStyle = this.colors.blood;
      g.fillRect(x + 3, y - 4, Math.max(1, Math.round(((w - 6) * z.hp) / z.maxHp)), 1);
    }
  }

  // ---- backdrop ----------------------------------------------------------------------------------------

  private buildBackdrop(): HTMLCanvasElement {
    const { w, h } = this;
    const a = this.art;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    const v = (n: string) => themeVar(n);
    const street = 13;
    const pavement = 4;
    const groundTop = h - street - pavement;

    // Sky: hard bands with a checkerboard dither between them (classic 8-bit gradient).
    const bands = [v('--title-sky-top'), v('--title-sky-mid'), v('--title-sky-low')];
    const bandH = Math.ceil(groundTop / bands.length);
    bands.forEach((col, i) => {
      g.fillStyle = col;
      g.fillRect(0, i * bandH, w, bandH);
      if (i > 0) {
        g.fillStyle = bands[i - 1]!;
        for (let yy = 0; yy < 2; yy++) for (let xx = (yy % 2); xx < w; xx += 2) g.fillRect(xx, i * bandH + yy, 1, 1);
      }
    });
    // A low, blood-orange sun behind the skyline.
    g.fillStyle = v('--title-logo-3');
    g.beginPath();
    g.arc(Math.round(w * 0.72), groundTop - 10, Math.round(Math.min(w, h) * 0.22), 0, Math.PI * 2);
    g.fill();
    // Distant ruined skyline with a few lit windows.
    const sky = v('--title-skyline');
    let sx = -4;
    while (sx < w) {
      const bw = Math.round(rand(10, 26));
      const bh = Math.round(rand(groundTop * 0.35, groundTop * 0.8));
      g.fillStyle = sky;
      g.fillRect(sx, groundTop - bh, bw, bh);
      // Broken roofline.
      for (let i = 0; i < bw; i += 3) if (Math.random() < 0.4) g.fillRect(sx + i, groundTop - bh - Math.round(rand(1, 4)), 2, 4);
      g.fillStyle = v('--title-logo-2');
      for (let i = 0; i < 3; i++) if (Math.random() < 0.5) g.fillRect(sx + Math.round(rand(2, bw - 3)), groundTop - Math.round(rand(6, bh - 4)), 1, 1);
      sx += bw + Math.round(rand(-2, 3));
    }

    // Street-facing buildings from the pack's facade tiles.
    const sets = [a.bldgBeige.img, a.bldgGray.img, a.bldgWhite.img, a.bldgDark.img];
    const T = 16;
    let bx = Math.round(rand(-20, -6));
    let n = 0;
    while (bx < w) {
      const cols = Math.round(rand(4, 7));
      const rows = Math.random() < 0.35 ? 2 : 3;
      const set = sets[n++ % sets.length]!;
      const top = groundTop - rows * T;
      const ruined = Math.random() < 0.35;
      for (let r = 0; r < rows; r++) {
        // Tile rows of the facade block: ledge (3), wall (4), plinth (5).
        const srcRow = r === 0 ? 3 : r === rows - 1 ? 5 : 4;
        for (let col = 0; col < cols; col++) {
          const srcCol = col === 0 ? 4 : col === cols - 1 ? 9 : 5 + ((col + n) % 4);
          if (ruined && r === 0 && Math.random() < 0.45) continue;
          g.drawImage(set, srcCol * T, srcRow * T, T, T, bx + col * T, top + r * T, T, T);
        }
      }
      // Shop window, door, awning, posters.
      if (cols >= 5) g.drawImage(set, 9 * T, 0, 2 * T, 2 * T, bx + T, groundTop - 2 * T - 1, 2 * T, 2 * T);
      const door = [a.door1, a.door2, a.door3][Math.floor(Math.random() * 3)]!.img;
      g.drawImage(door, bx + (cols - 2) * T, groundTop - door.height);
      if (Math.random() < 0.7) {
        const awn = (Math.random() < 0.5 ? a.awningOrange : a.awningBlue).img;
        g.drawImage(awn, bx + T - 8, groundTop - 2 * T - 8);
      }
      if (ruined) g.drawImage(a.holes.img, bx + (cols - 1) * T - 10, top + T + 2);
      if (Math.random() < 0.5) g.drawImage(a.posters.img, bx + Math.round(rand(4, cols * T - 20)), groundTop - 24);
      bx += cols * T + Math.round(rand(6, 20));
    }

    // Pavement and kerb.
    g.fillStyle = v('--title-pavement');
    g.fillRect(0, groundTop, w, pavement);
    g.fillStyle = v('--title-kerb');
    g.fillRect(0, groundTop + pavement - 1, w, 1);
    // Asphalt with specks and a dashed yellow line.
    g.fillStyle = v('--title-street');
    g.fillRect(0, h - street, w, street);
    for (let i = 0; i < w * street * 0.08; i++) {
      g.fillStyle = Math.random() < 0.5 ? v('--title-street-light') : v('--title-street-dark');
      g.fillRect(Math.floor(rand(0, w)), Math.floor(rand(h - street, h)), 1, 1);
    }
    g.fillStyle = v('--title-lane');
    for (let x = 4; x < w; x += 14) g.fillRect(x, h - street + 7, 7, 1);

    // Street furniture and wrecks along the pavement (behind the action).
    const props = [a.container, a.car1, a.car2, a.deadTree, a.light, a.barrel, a.barrel2, a.cone, a.tires, a.bricks];
    let px = Math.round(rand(70, 100));
    while (px < w - 8) {
      const p = props[Math.floor(Math.random() * props.length)]!.img;
      g.drawImage(p, px, groundTop + pavement - p.height + (p.height > 30 ? 2 : 0));
      px += p.width + Math.round(rand(14, 40));
    }
    return c;
  }
}
