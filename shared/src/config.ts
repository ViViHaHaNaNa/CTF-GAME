// ALL balance numbers live here. Distances are in tiles (16 px), times in seconds unless noted.
// Pacing target: a new player affords a first upgrade within ~1 minute, and a 5-10 minute turn
// feels like real progress.

export const POST_TYPES = ['pistol', 'gun', 'shotgun'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const ZOMBIE_KINDS = ['z_small', 'z_big', 'z_axe'] as const;
export type ZombieKind = (typeof ZOMBIE_KINDS)[number];

/** The Commander's weapons, in unlock order (BaseState.cmd is an index into this). */
export const COMMANDER_WEAPONS = ['pistol', 'gun', 'shotgun'] as const;
export type CommanderWeapon = (typeof COMMANDER_WEAPONS)[number];

export const RAIDER_KINDS = ['r_bat', 'r_pistol', 'r_helmet', 'r_shotgun'] as const;
export type RaiderKind = (typeof RAIDER_KINDS)[number];

/** Every unit kind the engine streams, in snapshot index order. */
export const UNIT_KINDS = [...ZOMBIE_KINDS, ...RAIDER_KINDS] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export const CONFIG = {
  /** Simulation rate of the combat engine (ticks per second). */
  tickRate: 20,
  /** Snapshots are streamed to clients every N ticks (clients interpolate between them). */
  snapshotEvery: 3,

  start: {
    /** Enough to buy a second pistol (60) at once, or upgrade the first (90) after a few kills. */
    coins: 120,
    /** New bases start with a pistol post in slot 0 so the first surge can be defended. */
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
    // Speeds/cooldowns are base values (x pace.zombieSpeed / pace.zombieCooldown). The siege overwhelms
    // with numbers, not toughness: Smalls are cheap, quick and die to 1-2 shots (a Lv1 pistol does 7),
    // so every kill pops a coin. Big and Axe zombies mix in as surges escalate.
    z_small: { hp: 12, speed: 1.5, damage: 4, cooldown: 0.8, range: 0.55, wallMult: 1, coins: 1, radius: 0.28 },
    z_axe: { hp: 40, speed: 1.0, damage: 9, cooldown: 1.0, range: 0.6, wallMult: 3, coins: 3, radius: 0.32 },
    z_big: { hp: 100, speed: 0.6, damage: 16, cooldown: 1.4, range: 0.65, wallMult: 1, coins: 6, radius: 0.42 },
  } as Record<ZombieKind, { hp: number; speed: number; damage: number; cooldown: number; range: number; wallMult: number; coins: number; radius: number }>,

  /**
   * Zombie defence: one continuous siege per base. Surges rise and fall (a brutal peak, a 3-5 s
   * breather, the next peak) from every side: the base's graveyard, the street/alley edges, its
   * manholes and cracks that open in the yard. A director scales the surges to keep a target share
   * of them held. Times in seconds.
   */
  siege: {
    /** After a base comes alive on screen, the first surge bursts in this soon (no countdown). */
    firstSurge: 2.5,
    /** Seconds a zombie spends climbing out of a grave, manhole or crack (harmless and untargetable). */
    riseTime: 0.6,
    /** The scripted first minute: each surge's size and the breather after it. Surge 1 is always this size. */
    ramp: [
      { size: 8, breather: 5 },
      { size: 12, breather: 4.5 },
      { size: 16, breather: 4 },
      { size: 21, breather: 3.5 },
    ],
    /**
     * After the ramp a surge is (base + perHq x (HQ-1) + perKill x firepower) x (1 + perMinute x minutes played,
     * up to maxMinutes) x pressure, capped at max. Firepower = Smalls per second the base's posts can kill, so
     * a surge always outnumbers what the defence can shoot down at once, however it's built.
     */
    size: { base: 4, perHq: 2, perKill: 10, perMinute: 0.03, maxMinutes: 10, max: 110 },
    /** Seconds over which a surge arrives. Each side's first zombie comes at once, so it's every side from the start. */
    spawnWindow: 4,
    /** From this surge on, surges are pincers: 2-3 sides get `pincerShare` of it within `pincerBurst` seconds. */
    pincerFrom: 5,
    pincerShare: 0.75,
    pincerBurst: 1.2,
    /** Breather after a surge (once the ramp is over): random between these. */
    breather: [3, 5] as [number, number],
    /** A surge still dragging on after this long counts as held, and the next one comes anyway. */
    maxSurge: 30,
    /** One stray Small every this many seconds during breathers (never while the base is losing). */
    trickleEvery: 1.4,
    /** Where a side's zombies come from (weights): running in off the street/alley edge, a crack in the yard, the side's manhole. */
    sources: { edge: 0.45, crack: 0.35, manhole: 0.2 },
    /** Share of every surge that rises from the base's graveyard. */
    graveyardShare: 0.15,
    /** Big and Axe shares of a surge, growing with Main Tower level and minutes played (the rest are Small). */
    mix: {
      z_big: { perHq: 0.015, perMinute: 0.008, max: 0.12 },
      z_axe: { perHq: 0.02, perMinute: 0.02, max: 0.18 },
    } as Record<'z_big' | 'z_axe', { perHq: number; perMinute: number; max: number }>,
    hpScale: (hq: number) => 1 + 0.15 * (hq - 1),
    damageScale: (hq: number) => 1 + 0.15 * (hq - 1),
    coinScale: (hq: number) => 1 + 0.1 * (hq - 1),
    /** Posts reach further in zombie defence (range x mult, at least min tiles), so any post covers every wall and the yard beyond. Raids use the plain ranges. */
    postRange: { mult: 1.4, min: 11 },
    /** Each breather, every building gets back this share of its max health (fallen walls and posts are rebuilt). */
    repair: 0.5,
    /** Most zombies alive on one base; spawns wait while it's full. */
    maxAlive: 120,
    difficulty: {
      /** Share of surges the director aims for players to hold: in their first `newMinutes` minutes, then after. */
      targetNew: 0.8,
      newMinutes: 5,
      target: 0.85,
      /** Pressure multiplies surge size. It starts here, drops `down` after a lost surge and creeps up after a held one (so the held share settles on the target). */
      start: 1,
      min: 0.45,
      max: 2.6,
      down: 0.25,
      /** In a player's first `newMinutes`, a surge held without the Main Tower dropping below `easyAbove` of its health climbs `easyMult` times faster (tappers settle quickly). */
      easyAbove: 0.9,
      easyMult: 2.5,
      /** Falling behind: once the Main Tower is below this share of health, only `easeKeep` of the surge's remaining zombies still come. */
      easeBelow: 0.45,
      easeKeep: 0.4,
    },
    breach: {
      /** Share of coins lost when the Main Tower falls... */
      lossPct: 0.05,
      /** ...never more than this... */
      maxLoss: 60,
      /** ...and never dropping the player below this. */
      protectedFloor: 100,
      /** The field clears and the base gets this long to recover. */
      breather: 6,
    },
    /** Ticks per second when a siege is resolved headlessly (offline bases): coarse but the same rules. */
    coarseRate: 10,
  },

  /**
   * Tap-to-attack: the player's Commander stands by the Main Tower and fires where they tap, during
   * their own base's zombie siege. The server resolves every shot.
   */
  commander: {
    /** A tap hits the zombie closest to the tap point within this many tiles (generous, for thumbs). */
    hitRadius: 1.5,
    /** Nothing that close: the shot still lands at the point and hits whatever is within this. */
    strayRadius: 0.45,
    /** Taps count anywhere within this many tiles of your plot: yard, walls, the streets and alleys around it, the graveyard. */
    reach: 6,
    /** A shot may arrive this many ticks early (network jitter) and still count as within the fire rate. */
    rateSlackTicks: 1,
    /**
     * Tap damage per second can't exceed share x the posts' damage per second (0.5 = a third of the total
     * defence), but is always allowed at least `floor`; up to `burst` seconds of it can be spent at once.
     * Shots beyond that hit softer. Crate attack boosts raise damage and the cap together.
     */
    dpsCap: { share: 0.5, floor: 16, burst: 1.5 },
    weapons: {
      pistol: { unlockHq: 1, cost: 0, damage: 7, fireRate: 5, magazine: 12, reload: 1.1, pellets: 1, spread: 0 },
      gun: { unlockHq: 2, cost: 300, damage: 10, fireRate: 5, magazine: 24, reload: 1.5, pellets: 1, spread: 0 },
      /** Pellets: the first hits the target, the rest the zombies nearest it within `spread` tiles. */
      shotgun: { unlockHq: 3, cost: 700, damage: 8, fireRate: 2.5, magazine: 6, reload: 1.8, pellets: 5, spread: 1.4 },
    } as Record<CommanderWeapon, { unlockHq: number; cost: number; damage: number; fireRate: number; magazine: number; reload: number; pellets: number; spread: number }>,
    /** Kills in a row without a miss: every `step` kills add x1 (up to `max`); tap kills pay coins x the multiplier. Idle `timeout` s resets it. */
    combo: { step: 8, max: 3, timeout: 5 },
    /** Tap a spot: after `delay` s, `damage` (x zombie hp scale) to everything within `radius` tiles. */
    airstrike: { cooldown: 25, delay: 1.2, radius: 2.6, damage: 45 },
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
    /** Coins earned while offline are banked up to this cap, credited at next login. */
    bankCap: 500,
    /** Offline bases resolve this many seconds of siege at a time, headlessly (coarse), once per that many seconds. */
    every: 45,
    /** Nobody taps while you're away: offline sieges use at most this pressure, whatever your tapping earned. */
    pressureCap: 1,
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
