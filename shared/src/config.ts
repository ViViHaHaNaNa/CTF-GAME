// ALL balance numbers live here. Distances are in tiles (16 px), times in seconds unless noted.
// Pacing target: a new player affords a first upgrade within ~1 minute, and a 5-10 minute turn
// feels like real progress.

export const POST_TYPES = ['pistol', 'gun', 'shotgun'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const ZOMBIE_KINDS = ['z_small', 'z_big', 'z_axe', 'z_boss'] as const;
export type ZombieKind = (typeof ZOMBIE_KINDS)[number];

/** Player modes: 'pve' grinds zombie surges (no raiding), 'pvp' pauses the swarms and may raid. */
export const MODES = ['pve', 'pvp'] as const;
export type Mode = (typeof MODES)[number];

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

  /**
   * The vault holds your coins. Zombie kill coins stop once it's full (raid loot and crate coins can go
   * over). Raiders who crack it take a bigger share of the loot. It grows with the Main Tower.
   */
  vault: {
    hp: (hq: number) => 250 + 90 * (hq - 1),
    /** Coins it holds, by Main Tower level (index = level - 1): always room for the next Main Tower upgrade. */
    capacity: [500, 1000, 1800, 3200, 5200, 8000, 12000, 16000],
    /** "Vault full" shows on the map from this share of capacity. */
    fullAt: 0.9,
  },

  /** Grind (PvE) or Raid (PvP). Every base can be raided whatever its mode; the mode decides what its owner can do. */
  modes: {
    /** New players start grinding. */
    start: 'pve' as Mode,
    /** Seconds between switches. Switching is also locked during a surge and while attacking or being attacked. */
    cooldown: 60,
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
    // Speeds/cooldowns are base values (x pace.zombieSpeed / pace.zombieCooldown). Smalls die to 1-2 shots;
    // tougher kinds unlock with level (CONFIG.siege.mix, bossChance). Coins per kill x CONFIG.siege.coinScale.
    z_small: { hp: 12, speed: 1.5, damage: 4, cooldown: 0.8, range: 0.55, wallMult: 1, coins: 2, radius: 0.28 },
    z_axe: { hp: 40, speed: 1.0, damage: 9, cooldown: 1.0, range: 0.6, wallMult: 3, coins: 4, radius: 0.32 },
    z_big: { hp: 100, speed: 0.6, damage: 16, cooldown: 1.4, range: 0.65, wallMult: 1, coins: 8, radius: 0.42 },
    /** A hulking Big (drawn twice the size): slow, very tough, wrecks walls. */
    z_boss: { hp: 900, speed: 0.45, damage: 35, cooldown: 1.6, range: 0.9, wallMult: 2, coins: 60, radius: 0.8 },
  } as Record<ZombieKind, { hp: number; speed: number; damage: number; cooldown: number; range: number; wallMult: number; coins: number; radius: number }>,

  /**
   * Zombie defence: one siege per grinding base, in surges on a regular, visible countdown that grows
   * with the Main Tower level. Early play is guided (one side, then two, small surges, aim assist,
   * a walkthrough first surge); sides, zombie types, surge size and the gap all grow with level.
   * Zombies come from the street/alley edges, manholes, cracks in the yard and (later) the graveyard.
   * A director nudges surge size to keep a target share of surges held. Times in seconds.
   */
  siege: {
    /** Seconds from a base coming alive to its first surge (a countdown shows). */
    firstSurge: 8,
    /** Seconds a zombie spends climbing out of a grave, manhole or crack (harmless and untargetable). */
    riseTime: 0.6,
    /** The countdown between surges, by Main Tower level (index = level - 1): regular, always shown, no trickle in between. */
    gap: [45, 60, 80, 100, 120, 150, 180, 210],
    /**
     * Zombies in a surge: (size[level] + perFire[level] x firepower) x the director's pressure, at most
     * `maxSize`. Firepower = Smalls per second the base's posts can kill, so from level 3 a surge keeps
     * up with the defence; guided levels (perFire 0) stay small and fixed.
     */
    size: [10, 16, 20, 26, 32, 38, 44, 50],
    perFire: [0, 0, 5, 6, 6, 6, 6, 6],
    maxSize: 160,
    /** Seconds a surge's zombies keep arriving, by level: with the fighting, a surge lasts about 30-50 s. */
    spawnWindow: [32, 33, 35, 37, 40, 43, 45, 47],
    /** A surge arrives in this many pulses spread over its window, by level (each pulse lands within `pulseSpread` s). */
    pulses: [2, 2, 3, 3, 3, 4, 4, 4],
    pulseSpread: 4,
    /** A surge still going after this long counts as held and the countdown starts. */
    maxSurge: 60,
    /** Sides a surge comes from, by level: one side at level 1, then 2, 3, and all 4 from level 4. */
    sides: [1, 2, 3, 4, 4, 4, 4, 4],
    /** From this level the base's graveyard joins in, with this share of each surge. */
    graveyardFrom: 4,
    graveyardShare: 0.15,
    /** From this level surges are pincers: `pincerShare` of a surge on 2-3 of its sides, arriving within `pincerBurst` s. */
    pincerFrom: 5,
    pincerShare: 0.6,
    pincerBurst: 4,
    /** Where a side's zombies come from (weights): running in off the street/alley edge, a crack in the yard, the side's manhole. */
    sources: { edge: 0.45, crack: 0.35, manhole: 0.2 },
    /** Zombie types unlock with level: Big from 3, Axe from 4 (share of each surge by level; the rest are Small). */
    mix: {
      z_big: [0, 0, 0.08, 0.1, 0.12, 0.13, 0.14, 0.15],
      z_axe: [0, 0, 0, 0.12, 0.15, 0.17, 0.18, 0.2],
    } as Record<'z_big' | 'z_axe', number[]>,
    /** A boss joins a surge with this chance, by level (from level 6). */
    bossChance: [0, 0, 0, 0, 0, 0.5, 0.75, 1],
    /** A new player's very first surge: a walkthrough from one side, and the Main Tower can't drop below `hqFloor` of its health. */
    tutorial: { size: 8, spawnWindow: 14, hqFloor: 0.5 },
    /** Guided play below this Main Tower level: gentler taps (CONFIG.commander.hitRadiusGuided) and the incoming sides shown for the whole countdown. */
    guidedBelow: 3,
    /** From level `guidedBelow`, the incoming sides show this many seconds before a surge. */
    warn: 15,
    /**
     * Call the next surge early: coins per second skipped, by level. Only once `minWait` of the countdown
     * has passed (so a gap shrinks by at most 60%) and with at least `minLeft` s to go. The bonus fills the vault like kills.
     */
    callEarly: { minWait: 0.4, minLeft: 3, perSecond: [0.4, 0.5, 0.6, 0.8, 1, 1.3, 1.6, 2] },
    hpScale: (hq: number) => 1 + 0.25 * (hq - 1),
    damageScale: (hq: number) => 1 + 0.25 * (hq - 1),
    /** Kill coins don't grow with level (surges do); holding a surge pays this bonus on top, by level. */
    coinScale: (_hq: number) => 1,
    holdBonus: [20, 45, 60, 60, 40, 40, 40, 40],
    /** Posts reach further in zombie defence (range x mult, at least min tiles), so any post covers every wall and the yard beyond. Raids use the plain ranges. */
    postRange: { mult: 1.4, min: 11 },
    /** After each surge everything is repaired by this share of max health (1 = fully; fallen walls and posts are rebuilt). */
    repair: 1,
    /** Most zombies alive on one base; spawns wait while it's full. */
    maxAlive: 120,
    difficulty: {
      /** Share of surges the director aims for players to hold: in their first `newMinutes` minutes, then after. */
      targetNew: 0.8,
      newMinutes: 5,
      target: 0.85,
      /** Pressure multiplies surge size (the level sets the base size). It drops `down` after a lost surge and creeps up after a held one. */
      start: 1,
      min: 0.7,
      max: 2.5,
      down: 0.15,
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
    /** Aim assist while guided (Main Tower below CONFIG.siege.guidedBelow): an even more generous radius. */
    hitRadiusGuided: 2.2,
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
    /**
     * Raids have no countdown. One ends when everything that counts is down (Main Tower, posts, vault;
     * not walls), when every raider is dead and the attacker can't send more, or when they tap End attack.
     * Anti-stall: these end it too, so a raid can never hang.
     */
    stall: {
      /** After the first deploy: this long with no damage dealt by either side ends the raid. */
      noDamage: 15,
      /** Nothing deployed this long after the battle starts: cancelled, no cost to either player. */
      noDeploy: 30,
      /** Hidden failsafe (never shown): no raid runs longer than this. */
      failsafe: 360,
    },
    /** Stars: one for destroying this share of what counts, one for the Main Tower, one for everything. A win is 1+ star. */
    stars: { destruction: 0.5 },
    /** Raiders the attacker can send in one raid (with enough coins). */
    maxDeploys: 40,
    /** Raider stats grow with the attacker's Main Tower level. */
    troopScale: (hq: number) => 1 + 0.15 * (hq - 1),
    /** Base raider stats: speed x pace.raiderSpeed, cooldown x pace.raiderCooldown. */
    raiders: {
      r_bat: { unlockHq: 1, cost: 12, hp: 55, speed: 1.6, damage: 10, cooldown: 0.7, range: 0.5, wallMult: 1 },
      r_pistol: { unlockHq: 2, cost: 15, hp: 40, speed: 1.2, damage: 7, cooldown: 0.8, range: 3, wallMult: 0.6 },
      r_helmet: { unlockHq: 3, cost: 30, hp: 160, speed: 0.8, damage: 10, cooldown: 1.0, range: 0.55, wallMult: 1.5 },
      r_shotgun: { unlockHq: 4, cost: 27, hp: 65, speed: 1.0, damage: 20, cooldown: 1.4, range: 1.8, wallMult: 1 },
    } as Record<RaiderKind, { unlockHq: number; cost: number; hp: number; speed: number; damage: number; cooldown: number; range: number; wallMult: number }>,
    loot: {
      /**
       * Loot comes from what was destroyed, win or lose: `fromVault` of the stake for cracking the vault,
       * the rest in proportion to the destruction share.
       */
      fromVault: 0.5,
      /** The stake: this share of the defender's coins... */
      pct: 0.3,
      /** ...capped at base + perHq * defender HQ level... */
      capBase: 300,
      capPerHq: 150,
      /** ...and never taking the defender below this. */
      protectedFloor: 100,
      /**
       * On top of what's stolen, every star pays this bonus (by the defender's Main Tower level, x the match
       * factor), so raiding beats grinding per minute without stripping defenders bare. New coins, not theirs.
       */
      starBonus: [38, 45, 65, 100, 170, 225, 290, 370],
    },
    trophies: {
      /** For an even fight; x the match factor, kept within min..max. */
      base: 30,
      min: 5,
      max: 50,
      /** A win pays stars/3 of the stake (at least `min`); a 0-star raid costs the attacker this share of the stake. */
      lossFactor: 0.5,
    },
    /**
     * Match factor on loot and trophies: from the trophy gap (defender - attacker, `span` trophies = full
     * effect; weaker targets shrink it to `min`, stronger ones raise it up to `max`) times the Main Tower
     * gap (`perLevel` per level, within `levelMin`..`levelMax`). Hitting much weaker bases pays little.
     */
    match: { span: 400, min: 0.25, max: 1.5, perLevel: 0.2, levelMin: 0.3, levelMax: 1.6 },
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
    /**
     * Offline grinders get one surge at a time, resolved headlessly (coarse), then the level's countdown
     * (CONFIG.siege.gap) before the next. The first comes within this many seconds of a server start.
     */
    firstWithin: 45,
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
