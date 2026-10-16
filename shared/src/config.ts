// ALL balance numbers live here. Distances are in tiles (16 px), times in seconds unless noted.
// Pacing target: a new player affords a first upgrade within ~1 minute, and a 5-10 minute turn
// feels like real progress.

export const POST_TYPES = ['pistol', 'gun', 'shotgun'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const ZOMBIE_KINDS = ['z_small', 'z_big', 'z_axe'] as const;
export type ZombieKind = (typeof ZOMBIE_KINDS)[number];

export const RAIDER_KINDS = ['r_bat', 'r_pistol', 'r_helmet', 'r_shotgun'] as const;
export type RaiderKind = (typeof RAIDER_KINDS)[number];

/** Every unit kind the engine streams, in snapshot index order. */
export const UNIT_KINDS = [...ZOMBIE_KINDS, ...RAIDER_KINDS] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

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

  /**
   * Combat pace. Speeds and cooldowns in the tables below are base values; the game multiplies them
   * by these. Movement in tiles per second, cooldowns in seconds between hits/shots.
   */
  pace: {
    /** Raider walking speed. */
    raiderSpeed: 1.6,
    /** Time between raider hits/shots. */
    raiderCooldown: 0.7,
    /** Time between post shots. */
    postCooldown: 0.7,
    /** Zombie walking speed. */
    zombieSpeed: 1,
    /** Time between zombie hits. */
    zombieCooldown: 1,
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
      // Retuned for the faster pace (posts fire every cooldown x pace.postCooldown): a touch less damage, more health.
      pistol: { build: 60, range: 5.5, damage: 7, damagePerLevel: 3, cooldown: 0.6, hp: 165, hpPerLevel: 55, splash: 0 },
      gun: { build: 180, range: 7, damage: 11, damagePerLevel: 5, cooldown: 0.9, hp: 198, hpPerLevel: 66, splash: 0 },
      shotgun: { build: 300, range: 3.5, damage: 9, damagePerLevel: 4, cooldown: 1.3, hp: 242, hpPerLevel: 77, splash: 0.9 },
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
    // Speeds/cooldowns are base values (x pace.zombieSpeed / pace.zombieCooldown). Coins trimmed for the
    // faster pace, which kills more zombies per minute, so income stays about where it was.
    z_small: { hp: 30, speed: 1.4, damage: 5, cooldown: 0.8, range: 0.55, wallMult: 1, coins: 7 },
    z_big: { hp: 140, speed: 0.55, damage: 18, cooldown: 1.4, range: 0.65, wallMult: 1, coins: 17 },
    z_axe: { hp: 70, speed: 0.9, damage: 10, cooldown: 1.0, range: 0.6, wallMult: 3, coins: 10 },
  } as Record<ZombieKind, { hp: number; speed: number; damage: number; cooldown: number; range: number; wallMult: number; coins: number }>,

  waves: {
    /** Seconds of calm between waves. */
    calm: 10,
    /** A wave ends after this long even if zombies remain (counts as defended). */
    maxDuration: 40,
    /** Zombies trickle in over this many seconds. */
    spawnSpread: 12,
    /** Seconds a zombie spends climbing out of its grave (harmless and untargetable). */
    riseTime: 0.6,
    /** Seconds of warning shown above the graveyard before a wave. */
    warning: 5,
    count: (hq: number) => 4 + 2 * (hq - 1),
    /** Relative spawn weights by HQ level. */
    mix: (hq: number) => ({ z_small: 0.65 - 0.03 * (hq - 1), z_big: 0.15 + 0.015 * (hq - 1), z_axe: 0.2 + 0.015 * (hq - 1) }),
    hpScale: (hq: number) => 1 + 0.25 * (hq - 1),
    damageScale: (hq: number) => 1 + 0.15 * (hq - 1),
    coinScale: (hq: number) => 1 + 0.12 * (hq - 1),
    breach: {
      /** Share of coins lost when the HQ falls... */
      lossPct: 0.1,
      /** ...never more than this... */
      maxLoss: 300,
      /** ...and never dropping the player below this. */
      protectedFloor: 100,
    },
  },

  pvp: {
    /** Battle length in seconds. */
    duration: 180,
    /** Destruction share (non-wall buildings) that wins the raid. Losing the Main Tower also wins it. */
    winDestruction: 0.5,
    /** The raid ends early if no raider is alive and nothing was deployed for this long. */
    idleEnd: 20,
    maxDeploys: 40,
    /** Raider stats grow with the attacker's Main Tower level. */
    troopScale: (hq: number) => 1 + 0.15 * (hq - 1),
    /** Base raider stats: speed x pace.raiderSpeed, cooldown x pace.raiderCooldown. */
    raiders: {
      r_bat: { unlockHq: 1, cost: 20, hp: 55, speed: 1.6, damage: 10, cooldown: 0.7, range: 0.5, wallMult: 1 },
      r_pistol: { unlockHq: 2, cost: 25, hp: 40, speed: 1.2, damage: 7, cooldown: 0.8, range: 3, wallMult: 0.6 },
      r_helmet: { unlockHq: 3, cost: 50, hp: 160, speed: 0.8, damage: 10, cooldown: 1.0, range: 0.55, wallMult: 1.5 },
      r_shotgun: { unlockHq: 4, cost: 45, hp: 65, speed: 1.0, damage: 20, cooldown: 1.4, range: 1.8, wallMult: 1 },
    } as Record<RaiderKind, { unlockHq: number; cost: number; hp: number; speed: number; damage: number; cooldown: number; range: number; wallMult: number }>,
    loot: {
      /** Share of the defender's coins a winning raid steals... */
      pct: 0.2,
      /** ...capped at base + perHq * defender HQ level... */
      capBase: 300,
      capPerHq: 150,
      /** ...and never taking the defender below this. */
      protectedFloor: 100,
    },
    trophies: {
      base: 30,
      /** Extra/less trophies per point of trophy difference (defender - attacker). */
      perDiff: 0.05,
      min: 5,
      max: 50,
      /** A failed raid costs the attacker this share of what a win would have paid. */
      lossFactor: 0.5,
    },
    /** Raiding a much weaker player (fewer trophies) pays less loot: factor shrinks to `min` at `span` trophies below. */
    weaker: { span: 400, min: 0.25 },
    /** After being raided, a base is protected from raids for this long. */
    autoShield: 120,
  },

  /** Bought PvP protection. Doesn't stop zombie waves; attacking someone ends it. */
  immunity: {
    options: [
      { minutes: 5, cost: 150 },
      { minutes: 10, cost: 250 },
    ],
    /** Buying more extends it, up to this much time left. */
    maxMinutes: 15,
  },

  crates: {
    /** A global crate drops this often (seconds); an unclaimed one expires when the next drops. */
    every: 600,
    /** First crate after a server start (seconds), unless one was already scheduled. */
    firstDelay: 60,
    /** Rarity weights (ammo-crate colours: green rare, blue epic, red legendary). */
    weights: { rare: 60, epic: 30, legendary: 10 },
    /** After a wrong answer a player waits this long (seconds)... */
    wrongCooldown: 3,
    /** ...and every `lockAfter`-th wrong answer locks them out for `lockFor` seconds. */
    lockAfter: 5,
    lockFor: 30,
    boosts: {
      /** Raider damage for the next `uses` raids. */
      attack: { pct: { rare: 0.25, epic: 0.4, legendary: 0.6 }, uses: 3 },
      /** Post damage and health (waves and raids) for `minutes`. */
      defence: { pct: { rare: 0.25, epic: 0.4, legendary: 0.6 }, minutes: 30 },
      /** Loot from the next raid. */
      loot: { pct: { rare: 0.5, epic: 0.75, legendary: 1 }, uses: 1 },
    },
    /** Paid instead when every boost the crate could give is already active at a stronger level. */
    consolation: { rare: 100, epic: 200, legendary: 400 },
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
    cooldown: Math.round(t.cooldown * CONFIG.pace.postCooldown * 100) / 100,
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
