// ALL balance numbers live here. Distances are in tiles (16 px), times in seconds unless noted.
// Pacing target: a new player affords a first upgrade within ~1 minute, and a 5-10 minute turn
// feels like real progress.

export const POST_TYPES = ['pistol', 'gun', 'shotgun'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const ZOMBIE_KINDS = ['z_small', 'z_big', 'z_axe'] as const;
export type ZombieKind = (typeof ZOMBIE_KINDS)[number];

export const CONFIG = {
  /** Simulation rate of the combat engine (ticks per second). */
  tickRate: 20,
  /** Snapshots are streamed to clients every N ticks. */
  snapshotEvery: 2,

  start: {
    coins: 120,
    /** New bases start with a pistol post in slot 0 so the first wave can be defended. */
    starterPost: 'pistol' as PostType,
  },

  hq: {
    maxLevel: 8,
    hp: (level: number) => 600 + 250 * (level - 1),
    /** Cost to go from level i+1 to i+2 (index 0 = 1 -> 2). */
    upgradeCost: [250, 600, 1200, 2200, 3800, 6000, 9000],
    /** Build slots for posts unlocked at each HQ level (index = level - 1). */
    slotsUnlocked: [2, 3, 4, 5, 6, 7, 8, 8],
    /** Which post types each HQ level allows. */
    postUnlock: { pistol: 1, gun: 2, shotgun: 3 } as Record<PostType, number>,
  },

  posts: {
    maxLevel: 8,
    /** Level at which survivors get helmets (visual only). */
    helmetFromLevel: 4,
    types: {
      pistol: { build: 60, range: 5.5, damage: 7, damagePerLevel: 3, cooldown: 0.6, hp: 150, hpPerLevel: 50, splash: 0 },
      gun: { build: 180, range: 7, damage: 12, damagePerLevel: 5, cooldown: 0.9, hp: 180, hpPerLevel: 60, splash: 0 },
      shotgun: { build: 300, range: 3.5, damage: 9, damagePerLevel: 4, cooldown: 1.3, hp: 220, hpPerLevel: 70, splash: 0.9 },
    } as Record<PostType, { build: number; range: number; damage: number; damagePerLevel: number; cooldown: number; hp: number; hpPerLevel: number; splash: number }>,
    /** Upgrade cost from level L to L+1 = build cost * growth^L. */
    upgradeGrowth: 1.55,
  },

  walls: {
    maxLevel: 8,
    /** Levels from this one up use the reinforced wall sprites. */
    reinforcedFromLevel: 5,
    hp: (level: number) => 150 + 100 * (level - 1),
    /** Cost from level L to L+1 = base * growth^(L-1). */
    upgradeBase: 70,
    upgradeGrowth: 1.6,
  },

  zombies: {
    z_small: { hp: 30, speed: 1.4, damage: 5, cooldown: 0.8, range: 0.55, wallMult: 1, coins: 8 },
    z_big: { hp: 140, speed: 0.55, damage: 18, cooldown: 1.4, range: 0.65, wallMult: 1, coins: 20 },
    z_axe: { hp: 70, speed: 0.9, damage: 10, cooldown: 1.0, range: 0.6, wallMult: 3, coins: 12 },
  } as Record<ZombieKind, { hp: number; speed: number; damage: number; cooldown: number; range: number; wallMult: number; coins: number }>,

  waves: {
    /** Seconds of calm between waves. */
    calm: 10,
    /** A wave ends after this long even if zombies remain (counts as defended). */
    maxDuration: 40,
    /** Zombies trickle in over this many seconds. */
    spawnSpread: 12,
    count: (hq: number) => 4 + 2 * (hq - 1),
    /** Relative spawn weights by HQ level. */
    mix: (hq: number) => ({ z_small: 0.65 - 0.03 * (hq - 1), z_big: 0.15 + 0.015 * (hq - 1), z_axe: 0.2 + 0.015 * (hq - 1) }),
    hpScale: (hq: number) => 1 + 0.25 * (hq - 1),
    damageScale: (hq: number) => 1 + 0.15 * (hq - 1),
    coinScale: (hq: number) => 1 + 0.12 * (hq - 1),
    /** Each wave comes from 1 or 2 sides of the map. */
    maxSides: 2,
    breach: {
      /** Share of coins lost when the HQ falls... */
      lossPct: 0.1,
      /** ...never more than this... */
      maxLoss: 300,
      /** ...and never dropping the player below this. */
      protectedFloor: 100,
    },
  },

  offline: {
    /** Coins earned by waves while offline are banked up to this cap, credited at next login. */
    bankCap: 500,
    /** Offline bases get a headless wave every this many seconds (calm + a typical wave). */
    waveEvery: 45,
  },

  account: {
    nameMin: 2,
    nameMax: 16,
    /** Roll numbers: letters/digits, normalised to upper case. */
    rollPattern: /^[A-Z0-9]{4,15}$/,
  },
} as const;

/** Rounds to a "nice" price. */
export function nice(n: number): number {
  return n < 100 ? Math.round(n / 5) * 5 : Math.round(n / 10) * 10;
}

export function postStats(type: PostType, level: number) {
  const t = CONFIG.posts.types[type];
  return {
    range: t.range,
    damage: t.damage + t.damagePerLevel * (level - 1),
    cooldown: t.cooldown,
    hp: t.hp + t.hpPerLevel * (level - 1),
    splash: t.splash,
  };
}

export function postUpgradeCost(type: PostType, level: number): number {
  return nice(CONFIG.posts.types[type].build * CONFIG.posts.upgradeGrowth ** level);
}

export function wallUpgradeCost(level: number): number {
  return nice(CONFIG.walls.upgradeBase * CONFIG.walls.upgradeGrowth ** (level - 1));
}

export function hqUpgradeCost(level: number): number | null {
  return level >= CONFIG.hq.maxLevel ? null : CONFIG.hq.upgradeCost[level - 1]!;
}

export function slotsUnlocked(hq: number): number {
  return CONFIG.hq.slotsUnlocked[hq - 1]!;
}
