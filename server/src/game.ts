import { randomBytes } from 'node:crypto';
import {
  CONFIG,
  POST_TYPES,
  Raid,
  ZombieWave,
  applyAction,
  breachLoss,
  checkAnswer,
  currentPct,
  getWorld,
  grantCrate,
  liveBoosts,
  isRaiderKind,
  lootable,
  newBase,
  parseAction,
  quote,
  rollRarity,
  trophyStake,
  weakerFactor,
  type BaseSummary,
  type CrateView,
  type FeedItem,
  type OfflineSummary,
  type PlayerView,
  type Question,
  type Rarity,
  type RaidResult,
  type RaidStatus,
  type Snapshot,
} from '@siege/shared';
import type { PlayerRecord, Store } from './store.ts';

// The authoritative game. Owns every player's state in memory and writes each change straight to the
// store. Zombie waves run live (streamed) for bases someone is looking at, and headlessly for the rest.
// Raids run live for everyone watching that base. It knows nothing about sockets: it talks through Outbox.

export class GameError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface Outbox {
  /** Every connected screen of one player. */
  toPlayer(id: number, event: string, data: unknown): void;
  /** Everyone watching a plot (its owner's screens always do). */
  toBase(plot: number, event: string, data: unknown): void;
  /** Everyone. */
  toAll(event: string, data: unknown): void;
}

/** What a screen needs to start showing a base's live action. */
export interface BaseLive {
  p: number;
  phase: 'calm' | 'warning' | 'wave' | 'raid';
  /** Seconds until zombies rise (calm / warning). */
  nextIn?: number;
  graveyard?: number;
  snapshot?: Snapshot;
  raid?: RaidStatus;
}

interface Live {
  phase: 'calm' | 'wave';
  calmUntil: number; // server tick
  warned: boolean;
  wave: ZombieWave | null;
}

interface RaidState {
  raid: Raid;
  attackerId: number;
  defenderId: number;
  spent: number;
  /** The attacker's loot boost, used up by this raid. */
  lootBoost: number;
}

interface CrateState {
  id: number;
  qid: string;
  rarity: Rarity;
  spawnedAt: number;
  expiresAt: number;
  claimedBy?: { id: number; name: string };
  reward?: string;
}

/** Organiser switches, saved so a restart keeps them. */
interface AdminMeta {
  paused: boolean;
  pausedAt: number;
  /** Trophies shown on the leaderboard while it's frozen (player id -> trophies); null = live. */
  frozen: Record<number, number> | null;
}

/** Persisted crate schedule (store meta "crates"), so a restart neither repeats questions nor resets the timer. */
interface CrateMeta {
  seq: number;
  /** Question ids already used this cycle (no repeats until the bank is used up). */
  used: string[];
  current: CrateState | null;
  nextAt: number;
}

const emptyOffline = (): OfflineSummary => ({ waves: 0, breaches: 0, coinsEarned: 0, coinsLost: 0, capped: false, raids: 0, raidLosses: 0 });
const FEED_KEEP = 20;

/** Hash two ints into a 32-bit seed. */
function seedOf(a: number, b: number): number {
  let h = Math.imul(a ^ 0x5bd1e995, 0x01000193) ^ b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 12)) >>> 0;
}

export class GameServer {
  readonly players = new Map<number, PlayerRecord>();
  private byRoll = new Map<string, number>();
  private byToken = new Map<string, number>();
  private byPlot = new Map<number, number>();
  private sockets = new Map<number, number>();
  private watchers = new Map<number, number>();
  private live = new Map<number, Live>();
  private raids = new Map<number, RaidState>();
  private raidByPlot = new Map<number, number>();
  private raidByAttacker = new Map<number, number>();
  private nextOffline = new Map<number, number>();
  private dirty = new Set<number>();
  private summaries = new Map<number, BaseSummary>();
  private raidSeq = 0;
  private crate: CrateMeta;
  /** Organiser controls (persisted in store meta "admin"). */
  private admin: AdminMeta;
  /** Loop calls, counting paused ones (summaries keep flowing while paused). */
  private loopNo = 0;
  /** Wrong-answer rate limit per player, for the current crate. */
  private attempts = new Map<number, { crate: number; wrong: number; until: number }>();
  readonly feed: FeedItem[] = [];
  /** Server ticks since start (CONFIG.tickRate per second). */
  tickNo = 0;

  constructor(
    private readonly store: Store,
    private readonly out: Outbox,
    private readonly now: () => number = Date.now,
    private readonly questions: Question[] = [],
  ) {
    const t = now();
    this.admin = store.getMeta<AdminMeta>('admin') ?? { paused: false, pausedAt: 0, frozen: null };
    for (const p of store.loadPlayers()) {
      // Records from older versions get a plot (and the new fields) on load.
      p.shieldUntil ??= 0;
      p.immuneUntil ??= 0;
      p.boosts ??= {};
      if (p.plot === undefined || this.byPlot.has(p.plot)) {
        p.plot = this.freePlot();
        this.save(p);
      }
      this.index(p);
      // Spread the first offline waves out so a restart doesn't run every base at once.
      this.nextOffline.set(p.id, t + CONFIG.offline.waveEvery * 1000 * Math.random());
    }
    for (const p of this.players.values()) this.summaries.set(p.plot, this.summarize(p));
    this.crate = store.getMeta<CrateMeta>('crates') ?? { seq: 0, used: [], current: null, nextAt: 0 };
    if (this.crate.nextAt < t && !this.admin.paused) {
      // Down past the drop time (or first run): the next crate comes shortly after starting.
      this.crate.nextAt = t + CONFIG.crates.firstDelay * 1000;
      if (this.crate.current) this.crate.current.expiresAt = this.crate.nextAt;
      this.saveCrates();
    }
  }

  private index(p: PlayerRecord) {
    this.players.set(p.id, p);
    this.byRoll.set(p.roll, p.id);
    this.byToken.set(p.token, p.id);
    this.byPlot.set(p.plot, p.id);
  }

  private save(p: PlayerRecord) {
    this.store.savePlayer(p);
  }

  /** The free plot with the lowest registration order (centre of the map first). */
  private freePlot(): number {
    const free = getWorld()
      .plots.filter((p) => !this.byPlot.has(p.id))
      .sort((a, b) => a.order - b.order)[0];
    if (!free) throw new GameError('world_full', 'The world is full! Ask the organisers.');
    return free.id;
  }

  view(p: PlayerRecord): PlayerView {
    return {
      id: p.id,
      name: p.name,
      roll: p.roll,
      coins: p.coins,
      trophies: p.trophies,
      plot: p.plot,
      base: p.base,
      shieldUntil: p.shieldUntil,
      immuneUntil: p.immuneUntil,
      boosts: liveBoosts(p.boosts, this.now()),
    };
  }

  isOnline(id: number) {
    return (this.sockets.get(id) ?? 0) > 0;
  }

  ownerOf(plot: number): PlayerRecord | undefined {
    const id = this.byPlot.get(plot);
    return id === undefined ? undefined : this.players.get(id);
  }

  // ---- accounts ---------------------------------------------------------------------------------

  static normRoll(raw: unknown): string {
    return String(raw ?? '').toUpperCase().replace(/[\s\-_/.]/g, '');
  }

  static cleanName(raw: unknown): string {
    return String(raw ?? '').trim().replace(/\s+/g, ' ');
  }

  /** Display name + roll number. One account per roll number; the name must match on return. */
  login(rawName: unknown, rawRoll: unknown): PlayerRecord {
    const name = GameServer.cleanName(rawName);
    const roll = GameServer.normRoll(rawRoll);
    const a = CONFIG.account;
    if (name.length < a.nameMin || name.length > a.nameMax || !/^[\p{L}\p{N} ._'-]+$/u.test(name)) {
      throw new GameError('bad_name', `Name: ${a.nameMin}-${a.nameMax} letters, numbers or spaces`);
    }
    if (!a.rollPattern.test(roll)) throw new GameError('bad_roll', 'Enter a valid roll number (letters and digits)');
    const existing = this.byRoll.get(roll);
    if (existing !== undefined) {
      const p = this.players.get(existing)!;
      if (p.name.toLowerCase() !== name.toLowerCase()) throw new GameError('roll_taken', 'That roll number is registered under a different name');
      return p;
    }
    const t = this.now();
    const p = this.store.savePlayer({
      roll,
      name,
      token: randomBytes(24).toString('base64url'),
      coins: CONFIG.start.coins,
      trophies: 0,
      plot: this.freePlot(),
      base: newBase(),
      shieldUntil: 0,
      immuneUntil: 0,
      boosts: {},
      bank: 0,
      offline: emptyOffline(),
      waveNo: 0,
      createdAt: t,
      lastSeen: t,
    });
    this.index(p);
    this.nextOffline.set(p.id, t + CONFIG.offline.waveEvery * 1000);
    this.markDirty(p.plot);
    this.pushFeed(`${p.name} moved into the wasteland`, 'join');
    return p;
  }

  resume(token: unknown): PlayerRecord | null {
    const id = this.byToken.get(String(token ?? ''));
    return id === undefined ? null : this.players.get(id)!;
  }

  // ---- presence & watching ----------------------------------------------------------------------

  /** A screen of player `id` connected. The first one credits the offline bank. */
  connect(id: number): { player: PlayerView; offline: (OfflineSummary & { credited: number }) | null; feed: FeedItem[]; crate: CrateView | null } {
    const p = this.players.get(id)!;
    const n = (this.sockets.get(id) ?? 0) + 1;
    this.sockets.set(id, n);
    let offline: (OfflineSummary & { credited: number }) | null = null;
    if (n === 1) {
      if (p.offline.waves > 0 || p.bank > 0 || (p.offline.raids ?? 0) > 0) offline = { ...p.offline, credited: p.bank };
      p.coins += p.bank;
      p.bank = 0;
      p.offline = emptyOffline();
      p.lastSeen = this.now();
      this.save(p);
      this.markDirty(p.plot);
    }
    return { player: this.view(p), offline, feed: this.feed.slice(-10), crate: this.crateView() };
  }

  disconnect(id: number) {
    const n = Math.max(0, (this.sockets.get(id) ?? 0) - 1);
    this.sockets.set(id, n);
    if (n > 0) return;
    const p = this.players.get(id);
    if (!p) return;
    p.lastSeen = this.now();
    this.save(p);
  }

  /** A screen started (+1) or stopped (-1) looking at a plot. Watched bases get live waves. */
  watch(plot: number, delta: 1 | -1) {
    const n = Math.max(0, (this.watchers.get(plot) ?? 0) + delta);
    this.watchers.set(plot, n);
    const owner = this.ownerOf(plot);
    if (!owner) return;
    if (n > 0 && !this.live.has(plot)) {
      // First wave comes quickly so there's something to watch.
      this.live.set(plot, { phase: 'calm', calmUntil: this.tickNo + 3 * CONFIG.tickRate, warned: false, wave: null });
      this.nextOffline.delete(owner.id);
    } else if (n === 0 && this.live.has(plot)) {
      this.stopLive(plot);
    }
  }

  /** Nobody is looking any more: finish a running wave headlessly and go back to offline waves. */
  private stopLive(plot: number) {
    const l = this.live.get(plot);
    this.live.delete(plot);
    const p = this.ownerOf(plot);
    if (!p) return;
    if (l?.wave && !l.wave.done) {
      const before = l.wave.coins;
      l.wave.runToEnd();
      this.credit(p, l.wave.coins - before);
      this.settleWave(p, l.wave, false);
    }
    this.setWaveFlag(plot, 0);
    this.nextOffline.set(p.id, this.now() + CONFIG.offline.waveEvery * 1000);
  }

  /** Current live state of a plot, for a screen that just started watching it. */
  baseLive(plot: number): BaseLive {
    const rid = this.raidByPlot.get(plot);
    if (rid !== undefined) {
      const r = this.raids.get(rid)!;
      return { p: plot, phase: 'raid', raid: this.raidStatus(r), snapshot: r.raid.combat.snapshot(true) };
    }
    const l = this.live.get(plot);
    if (!l) return { p: plot, phase: 'calm' };
    if (l.phase === 'wave' && l.wave) return { p: plot, phase: 'wave', graveyard: l.wave.plan.graveyard, snapshot: l.wave.combat.snapshot(true) };
    const nextIn = Math.max(0, (l.calmUntil - this.tickNo) / CONFIG.tickRate);
    return { p: plot, phase: nextIn <= CONFIG.waves.warning ? 'warning' : 'calm', nextIn, graveyard: getWorld().plots[plot]!.graveyard };
  }

  // ---- actions ----------------------------------------------------------------------------------

  /** Build or upgrade. Changes take effect from the next fight. */
  act(id: number, raw: unknown): PlayerView {
    this.assertRunning();
    const p = this.players.get(id);
    if (!p) throw new GameError('no_player', 'Not logged in');
    const action = parseAction(raw);
    if (!action) throw new GameError('bad_action', 'Unknown action');
    const q = quote(p.base, action);
    if (!q.ok) throw new GameError('not_allowed', q.reason ?? 'Not allowed');
    if (p.coins < q.cost) throw new GameError('no_coins', `Need ${q.cost - p.coins} more coins`);
    p.coins -= q.cost;
    p.base = applyAction(p.base, action);
    this.save(p);
    this.markDirty(p.plot);
    return this.view(p);
  }

  /** Why `attackerId` can't raid `plot` right now (null = allowed). */
  raidBlock(attackerId: number, plot: number): string | null {
    const a = this.players.get(attackerId);
    const d = this.ownerOf(plot);
    if (!a) return 'Not logged in';
    if (!d) return 'Nobody lives there';
    if (d.id === a.id) return "That's your own base";
    if (this.raidByAttacker.has(a.id)) return 'Finish your current raid first';
    if (this.raidByPlot.has(plot)) return 'Already under attack';
    if (d.shieldUntil > this.now()) return 'Shielded';
    if (d.immuneUntil > this.now()) return 'Immune';
    return null;
  }

  attack(attackerId: number, plot: number): RaidStatus {
    this.assertRunning();
    const block = this.raidBlock(attackerId, Number(plot));
    if (block) throw new GameError('blocked', block);
    const a = this.players.get(attackerId)!;
    const d = this.ownerOf(plot)!;
    // A zombie wave in progress there stops; the base resumes waves after the raid.
    const l = this.live.get(plot);
    if (l) {
      l.phase = 'calm';
      l.wave = null;
      l.warned = false;
      l.calmUntil = Number.MAX_SAFE_INTEGER;
    }
    this.setWaveFlag(plot, 0);
    // Attacking ends your own immunity, and uses up one charge of your attack and loot boosts.
    const t = this.now();
    const attackBoost = currentPct(a.boosts, 'attack', t);
    const lootBoost = currentPct(a.boosts, 'loot', t);
    const b = liveBoosts(a.boosts, t);
    if (b.attack) b.attack = { ...b.attack, uses: b.attack.uses - 1 };
    if (b.loot) b.loot = { ...b.loot, uses: b.loot.uses - 1 };
    a.boosts = liveBoosts(b, t);
    a.immuneUntil = 0;
    this.save(a);
    this.markDirty(a.plot);
    this.out.toPlayer(a.id, 'player', this.view(a));
    const id = ++this.raidSeq;
    const raid = new Raid(id, getWorld().plots[plot]!, d.base, a.base.hq, seedOf(id, this.tickNo), { attack: attackBoost, defence: this.defenceBoost(d) });
    const r: RaidState = { raid, attackerId: a.id, defenderId: d.id, spent: 0, lootBoost };
    this.raids.set(id, r);
    this.raidByPlot.set(plot, id);
    this.raidByAttacker.set(a.id, id);
    this.markDirty(plot);
    const status = this.raidStatus(r);
    this.out.toBase(plot, 'raid', status);
    this.out.toPlayer(d.id, 'underAttack', status);
    return status;
  }

  deploy(attackerId: number, rawKind: unknown, rawX: unknown, rawY: unknown): { coins: number } {
    this.assertRunning();
    const rid = this.raidByAttacker.get(attackerId);
    if (rid === undefined) throw new GameError('no_raid', 'You are not raiding anyone');
    if (!isRaiderKind(rawKind)) throw new GameError('bad_kind', 'Unknown raider');
    const r = this.raids.get(rid)!;
    const a = this.players.get(attackerId)!;
    const x = Number(rawX);
    const y = Number(rawY);
    const why = r.raid.canDeploy(rawKind, x, y);
    if (why) throw new GameError('bad_deploy', why);
    const cost = CONFIG.pvp.raiders[rawKind].cost;
    if (a.coins < cost) throw new GameError('no_coins', `Need ${cost - a.coins} more coins`);
    a.coins -= cost;
    r.spent += cost;
    this.save(a);
    this.markDirty(a.plot);
    r.raid.deploy(rawKind, x, y);
    return { coins: a.coins };
  }

  retreat(attackerId: number) {
    const rid = this.raidByAttacker.get(attackerId);
    if (rid === undefined) return;
    this.raids.get(rid)!.raid.retreat();
  }

  raidStatus(r: RaidState): RaidStatus {
    return {
      id: r.raid.id,
      plot: r.raid.plot.id,
      attackerId: r.attackerId,
      attacker: this.players.get(r.attackerId)!.name,
      defender: this.players.get(r.defenderId)!.name,
      left: Math.ceil(r.raid.ticksLeft / CONFIG.tickRate),
      destruction: Math.round(100 * r.raid.combat.destruction()),
      deployed: r.raid.deployed,
    };
  }

  /** Raids in progress (the "live" list). */
  liveRaids(): RaidStatus[] {
    return [...this.raids.values()].map((r) => this.raidStatus(r));
  }

  // ---- simulation -------------------------------------------------------------------------------

  /** Advance one server tick. */
  tick() {
    this.loopNo++;
    if (!this.admin.paused) {
      this.tickNo++;
      for (const [plot, l] of this.live) this.tickLive(plot, l);
      for (const r of this.raids.values()) this.tickRaid(r);
      if (this.tickNo % CONFIG.tickRate === 0) {
        this.tickOffline(5);
        if (this.questions.length && this.now() >= this.crate.nextAt) this.spawnCrate();
      }
    }
    if (this.loopNo % (CONFIG.tickRate / 2) === 0) this.flushSummaries();
  }

  /** Coins from kills go straight to an online owner, or into the capped offline bank. */
  private credit(p: PlayerRecord, coins: number) {
    if (coins <= 0) return;
    if (this.isOnline(p.id)) {
      p.coins += coins;
      this.out.toPlayer(p.id, 'coins', { coins: p.coins, delta: coins });
    } else {
      const room = Math.max(0, CONFIG.offline.bankCap - p.bank);
      p.bank += Math.min(room, coins);
      p.offline.coinsEarned += Math.min(room, coins);
      if (coins > room) p.offline.capped = true;
    }
    this.save(p);
    this.markDirty(p.plot);
  }

  private tickLive(plot: number, l: Live) {
    const p = this.ownerOf(plot);
    if (!p || this.raidByPlot.has(plot)) return;
    if (l.phase === 'calm') {
      const warnAt = l.calmUntil - CONFIG.waves.warning * CONFIG.tickRate;
      if (!l.warned && this.tickNo >= warnAt) {
        l.warned = true;
        this.setWaveFlag(plot, 1);
        this.out.toBase(plot, 'wave', this.baseLive(plot));
      }
      if (this.tickNo < l.calmUntil) return;
      p.waveNo++;
      this.save(p);
      l.wave = new ZombieWave(p.base, seedOf(p.id, p.waveNo), getWorld().plots[plot]!, this.defenceBoost(p));
      l.phase = 'wave';
      this.setWaveFlag(plot, 2);
      this.out.toBase(plot, 'wave', this.baseLive(plot));
      return;
    }
    const w = l.wave!;
    this.credit(p, w.step());
    if (w.combat.tick % CONFIG.snapshotEvery === 0 || w.done) this.out.toBase(plot, 'snap', { p: plot, ...w.combat.snapshot() });
    if (w.done) {
      this.settleWave(p, w, true);
      l.phase = 'calm';
      l.wave = null;
      l.warned = false;
      l.calmUntil = this.tickNo + CONFIG.waves.calm * CONFIG.tickRate;
      this.setWaveFlag(plot, 0);
      this.out.toBase(plot, 'wave', this.baseLive(plot));
    }
  }

  /** End of a wave (kill coins were already credited as they happened). */
  private settleWave(p: PlayerRecord, w: ZombieWave, notify: boolean) {
    const lost = w.breached ? breachLoss(p.coins) : 0;
    p.coins -= lost;
    if (!this.isOnline(p.id)) {
      p.offline.waves++;
      if (w.breached) p.offline.breaches++;
      p.offline.coinsLost += lost;
    }
    this.save(p);
    this.markDirty(p.plot);
    if (notify) this.out.toBase(p.plot, 'waveEnd', { p: p.plot, breached: w.breached, kills: w.kills, coins: w.coins, lost, total: p.coins });
  }

  private tickRaid(r: RaidState) {
    const raid = r.raid;
    raid.step();
    const plot = raid.plot.id;
    if (raid.combat.tick % CONFIG.snapshotEvery === 0 || raid.done) this.out.toBase(plot, 'snap', { p: plot, ...raid.combat.snapshot() });
    if (raid.combat.tick % CONFIG.tickRate === 0) this.out.toBase(plot, 'raid', this.raidStatus(r));
    if (raid.done) this.settleRaid(r);
  }

  private settleRaid(r: RaidState) {
    const raid = r.raid;
    const plot = raid.plot.id;
    const a = this.players.get(r.attackerId)!;
    const d = this.players.get(r.defenderId)!;
    const stake = trophyStake(a.trophies, d.trophies);
    const rankBefore = this.rankOf(a.id);
    let loot = 0;
    let trophies = 0;
    if (raid.won) {
      loot = Math.round(lootable(d.coins, d.base.hq) * weakerFactor(a.trophies, d.trophies) * (1 + r.lootBoost));
      loot = Math.max(0, Math.min(loot, d.coins - CONFIG.pvp.loot.protectedFloor));
      d.coins -= loot;
      a.coins += loot;
      trophies = stake;
      a.trophies += stake;
      d.trophies = Math.max(0, d.trophies - stake);
    } else {
      trophies = -Math.round(stake * CONFIG.pvp.trophies.lossFactor);
      const lose = Math.min(a.trophies, -trophies);
      a.trophies -= lose;
      d.trophies += lose;
    }
    d.shieldUntil = this.now() + CONFIG.pvp.autoShield * 1000;
    if (!this.isOnline(d.id)) {
      d.offline.raids = (d.offline.raids ?? 0) + 1;
      d.offline.raidLosses = (d.offline.raidLosses ?? 0) + loot;
    }
    this.save(a);
    this.save(d);
    this.raids.delete(raid.id);
    this.raidByPlot.delete(plot);
    this.raidByAttacker.delete(a.id);
    this.markDirty(plot);
    this.markDirty(a.plot);
    const result: RaidResult = { id: raid.id, plot, attacker: a.name, defender: d.name, won: raid.won, destruction: Math.round(100 * raid.combat.destruction()), loot, trophies, spent: r.spent };
    this.out.toBase(plot, 'raidEnd', result);
    this.out.toPlayer(a.id, 'raidEnd', result);
    this.out.toPlayer(d.id, 'player', this.view(d));
    this.out.toPlayer(a.id, 'player', this.view(a));
    this.pushFeed(raid.won ? `${a.name} raided ${d.name} for ${loot} coins (+${trophies} trophies)` : `${d.name} fought off ${a.name}`, 'raid');
    // Climbing into the top 3 (or to #1) is news.
    const rankAfter = this.rankOf(a.id);
    if (!this.admin.frozen && rankAfter < rankBefore && rankAfter <= 3 && a.trophies > 0) this.pushFeed(rankAfter === 1 ? `${a.name} is now #1!` : `${a.name} climbed to #${rankAfter}`, 'rank');
    // Zombies come back a little after the raiders leave.
    const l = this.live.get(plot);
    if (l) l.calmUntil = this.tickNo + CONFIG.waves.calm * CONFIG.tickRate;
  }

  /** Resolve due offline waves (at most `budget` per call, to keep each tick cheap). */
  tickOffline(budget: number) {
    const t = this.now();
    for (const [id, due] of this.nextOffline) {
      if (budget <= 0) break;
      if (due > t) continue;
      const p = this.players.get(id);
      if (!p || this.live.has(p.plot) || this.raidByPlot.has(p.plot)) {
        this.nextOffline.set(id, t + CONFIG.offline.waveEvery * 1000);
        continue;
      }
      budget--;
      this.runOfflineWave(p);
      this.nextOffline.set(id, t + CONFIG.offline.waveEvery * 1000);
    }
  }

  runOfflineWave(p: PlayerRecord) {
    p.waveNo++;
    const w = new ZombieWave(p.base, seedOf(p.id, p.waveNo), getWorld().plots[p.plot]!, this.defenceBoost(p));
    w.runToEnd();
    const room = Math.max(0, CONFIG.offline.bankCap - p.bank);
    const banked = Math.min(room, w.coins);
    p.bank += banked;
    const lost = w.breached ? breachLoss(p.coins) : 0;
    p.coins -= lost;
    p.offline = {
      ...p.offline,
      waves: p.offline.waves + 1,
      breaches: p.offline.breaches + (w.breached ? 1 : 0),
      coinsEarned: p.offline.coinsEarned + banked,
      coinsLost: p.offline.coinsLost + lost,
      capped: p.offline.capped || banked < w.coins,
    };
    this.save(p);
    this.markDirty(p.plot);
  }

  /** Leaderboard position (1 = most trophies; ties keep the earlier player ahead). */
  rankOf(id: number): number {
    const me = this.players.get(id);
    if (!me) return Infinity;
    let rank = 1;
    for (const p of this.players.values()) if (p.trophies > me.trophies || (p.trophies === me.trophies && p.id < me.id)) rank++;
    return rank;
  }

  // ---- immunity & boosts ------------------------------------------------------------------------

  private defenceBoost(p: PlayerRecord): number {
    return currentPct(p.boosts, 'defence', this.now());
  }

  /** Buy PvP immunity (minutes must be one of the offered options). Extends any running immunity. */
  buyImmunity(id: number, rawMinutes: unknown): PlayerView {
    this.assertRunning();
    const p = this.players.get(id);
    if (!p) throw new GameError('no_player', 'Not logged in');
    const opt = CONFIG.immunity.options.find((o) => o.minutes === Number(rawMinutes));
    if (!opt) throw new GameError('bad_option', 'Pick 5 or 10 minutes');
    if (this.raidByAttacker.has(id)) throw new GameError('raiding', 'Finish your raid first');
    if (this.raidByPlot.has(p.plot)) throw new GameError('under_attack', 'You are being raided right now');
    const t = this.now();
    const from = Math.max(t, p.immuneUntil);
    if (from + opt.minutes * 60_000 - t > CONFIG.immunity.maxMinutes * 60_000) {
      throw new GameError('too_long', `Immunity can't run past ${CONFIG.immunity.maxMinutes} minutes`);
    }
    if (p.coins < opt.cost) throw new GameError('no_coins', `Need ${opt.cost - p.coins} more coins`);
    p.coins -= opt.cost;
    p.immuneUntil = from + opt.minutes * 60_000;
    this.save(p);
    this.markDirty(p.plot);
    return this.view(p);
  }

  // ---- crates -----------------------------------------------------------------------------------

  private saveCrates() {
    this.store.setMeta('crates', this.crate);
  }

  crateView(): CrateView | null {
    const c = this.crate.current;
    if (!c) return null;
    const q = this.questions.find((x) => x.id === c.qid);
    if (!q) return null;
    return {
      id: c.id,
      rarity: c.rarity,
      prompt: q.prompt,
      code: q.code,
      lang: q.lang,
      kind: q.kind,
      spawnedAt: c.spawnedAt,
      expiresAt: c.expiresAt,
      ...(c.claimedBy ? { claimedBy: c.claimedBy.name, reward: c.reward, answer: q.answers[0] } : {}),
    };
  }

  /** Drop a new global crate (replacing an unclaimed one). Also for the admin page. */
  spawnCrate(rarity?: Rarity): CrateView | null {
    if (!this.questions.length) return null;
    const t = this.now();
    const c = this.crate;
    if (c.current && !c.current.claimedBy) this.pushFeed(`Nobody cracked the ${c.current.rarity} crate in time`, 'crate');
    let pool = this.questions.filter((q) => !c.used.includes(q.id));
    if (!pool.length) {
      c.used = [];
      pool = [...this.questions];
    }
    const q = pool[Math.floor(Math.random() * pool.length)]!;
    c.used.push(q.id);
    c.seq++;
    c.nextAt = t + CONFIG.crates.every * 1000;
    c.current = { id: c.seq, qid: q.id, rarity: rarity ?? rollRarity(Math.random()), spawnedAt: t, expiresAt: c.nextAt };
    this.attempts.clear();
    this.saveCrates();
    const view = this.crateView();
    this.out.toAll('crate', view);
    this.pushFeed(`A ${c.current.rarity} crate dropped! First correct answer wins it`, 'crate');
    return view;
  }

  /**
   * A player's answer to the current crate. The check-and-claim runs synchronously on the single
   * game thread (no await in between), so exactly one player can ever win a crate.
   */
  answer(id: number, rawCrate: unknown, rawAnswer: unknown): { correct: boolean; retryIn?: number; reward?: string } {
    this.assertRunning();
    const p = this.players.get(id);
    if (!p) throw new GameError('no_player', 'Not logged in');
    const c = this.crate.current;
    const t = this.now();
    if (!c || c.id !== Number(rawCrate) || t >= c.expiresAt) throw new GameError('gone', 'That crate is gone');
    if (c.claimedBy) throw new GameError('claimed', `Too late: ${c.claimedBy.name} already claimed it`);
    let a = this.attempts.get(id);
    if (!a || a.crate !== c.id) {
      a = { crate: c.id, wrong: 0, until: 0 };
      this.attempts.set(id, a);
    }
    if (a.until > t) throw new GameError('wait', `Wait ${Math.ceil((a.until - t) / 1000)}s before trying again`);
    const q = this.questions.find((x) => x.id === c.qid)!;
    if (!checkAnswer(q, rawAnswer)) {
      a.wrong++;
      const wait = a.wrong % CONFIG.crates.lockAfter === 0 ? CONFIG.crates.lockFor : CONFIG.crates.wrongCooldown;
      a.until = t + wait * 1000;
      return { correct: false, retryIn: wait };
    }
    const g = grantCrate(p.boosts, c.rarity, t, Math.random());
    p.boosts = g.boosts;
    p.coins += g.coins;
    c.claimedBy = { id: p.id, name: p.name };
    c.reward = g.text;
    this.save(p);
    this.saveCrates();
    this.markDirty(p.plot);
    this.out.toAll('crate', this.crateView());
    this.out.toPlayer(p.id, 'player', this.view(p));
    this.pushFeed(`${p.name} cracked the ${c.rarity} crate: ${g.text}`, 'crate');
    return { correct: true, reward: g.text };
  }

  // ---- organiser controls (admin page) ----------------------------------------------------------

  /** What every screen is told about the organiser switches. */
  status(): { paused: boolean; frozen: boolean } {
    return { paused: this.admin.paused, frozen: this.admin.frozen !== null };
  }

  get paused() {
    return this.admin.paused;
  }

  private assertRunning() {
    if (this.admin.paused) throw new GameError('paused', 'The game is paused by the organisers');
  }

  private saveAdmin() {
    this.store.setMeta('admin', this.admin);
    this.out.toAll('status', this.status());
  }

  /**
   * Pause: no waves, raids, offline waves or crates, and players can't act (they can still look).
   * On resume, every wall-clock timer (crate, shields, immunity, defence boosts, offline waves) is
   * pushed back by the pause, so nobody loses protection or a crate to the break.
   */
  setPaused(on: boolean) {
    if (on === this.admin.paused) return;
    const t = this.now();
    if (on) {
      this.admin.pausedAt = t;
    } else {
      const d = Math.max(0, t - this.admin.pausedAt);
      const from = this.admin.pausedAt;
      this.crate.nextAt += d;
      if (this.crate.current) this.crate.current.expiresAt = this.crate.nextAt;
      this.saveCrates();
      for (const [id, due] of this.nextOffline) this.nextOffline.set(id, due + d);
      for (const p of this.players.values()) {
        let changed = false;
        if (p.shieldUntil > from) (p.shieldUntil += d), (changed = true);
        if (p.immuneUntil > from) (p.immuneUntil += d), (changed = true);
        if (p.boosts.defence && p.boosts.defence.until > from) {
          p.boosts = { ...p.boosts, defence: { ...p.boosts.defence, until: p.boosts.defence.until + d } };
          changed = true;
        }
        if (changed) {
          this.save(p);
          this.markDirty(p.plot);
          this.out.toPlayer(p.id, 'player', this.view(p));
        }
      }
      this.out.toAll('crate', this.crateView());
    }
    this.admin.paused = on;
    this.saveAdmin();
    this.pushFeed(on ? 'The organisers paused the game' : 'The game is back on!', 'info');
  }

  /** Freeze: the leaderboard everyone sees stops changing (raids still count; unfreezing reveals them). */
  setFrozen(on: boolean) {
    if (on === (this.admin.frozen !== null)) return;
    this.admin.frozen = on ? Object.fromEntries([...this.players.values()].map((p) => [p.id, p.trophies])) : null;
    for (const p of this.players.values()) this.markDirty(p.plot);
    this.saveAdmin();
    this.pushFeed(on ? 'The leaderboard is frozen' : 'The leaderboard is live again', 'rank');
  }

  /** Back to a fresh base (same account, name and plot). Not while they're in a raid. */
  resetPlayer(id: number): PlayerView {
    const p = this.players.get(id);
    if (!p) throw new GameError('no_player', 'No such player');
    if (this.raidByAttacker.has(id) || this.raidByPlot.has(p.plot)) throw new GameError('in_raid', 'They are in a raid right now; try again when it ends');
    p.coins = CONFIG.start.coins;
    p.trophies = 0;
    p.base = newBase();
    p.shieldUntil = 0;
    p.immuneUntil = 0;
    p.boosts = {};
    p.bank = 0;
    p.offline = emptyOffline();
    if (this.admin.frozen) this.admin.frozen[id] = 0;
    this.save(p);
    // A wave running there was built from the old base: stop it; the next one uses the new base.
    const l = this.live.get(p.plot);
    if (l) {
      l.phase = 'calm';
      l.wave = null;
      l.warned = false;
      l.calmUntil = this.tickNo + CONFIG.waves.calm * CONFIG.tickRate;
      this.setWaveFlag(p.plot, 0);
      this.out.toBase(p.plot, 'wave', this.baseLive(p.plot));
    }
    this.markDirty(p.plot);
    this.out.toPlayer(id, 'player', this.view(p));
    return this.view(p);
  }

  /** Remove an account entirely (test accounts, mistakes): frees the plot. Not while in a raid. */
  deletePlayer(id: number) {
    const p = this.players.get(id);
    if (!p) throw new GameError('no_player', 'No such player');
    if (this.raidByAttacker.has(id) || this.raidByPlot.has(p.plot)) throw new GameError('in_raid', 'They are in a raid right now; try again when it ends');
    if (this.live.has(p.plot)) this.stopLive(p.plot);
    this.store.deletePlayer(id);
    this.players.delete(id);
    this.byRoll.delete(p.roll);
    this.byToken.delete(p.token);
    this.byPlot.delete(p.plot);
    this.nextOffline.delete(id);
    this.summaries.delete(p.plot);
    if (this.admin.frozen) delete this.admin.frozen[id];
    this.out.toAll('world', { bases: this.worldSummary(), now: this.now(), full: true, raids: this.liveRaids() });
  }

  /** Everything the admin page shows (including the current crate's answers). */
  adminState() {
    const q = this.crate.current && this.questions.find((x) => x.id === this.crate.current!.qid);
    return {
      ...this.status(),
      now: this.now(),
      nextCrateAt: this.crate.nextAt,
      crate: this.crateView(),
      crateAnswers: q ? q.answers : [],
      questions: { total: this.questions.length, used: this.crate.used.length },
      raids: this.liveRaids(),
      feed: this.feed.slice(-15),
      players: [...this.players.values()]
        .map((p) => ({ id: p.id, name: p.name, roll: p.roll, plot: p.plot, hq: p.base.hq, coins: p.coins, trophies: p.trophies, online: this.isOnline(p.id), lastSeen: p.lastSeen }))
        .sort((a, b) => b.trophies - a.trophies || a.id - b.id),
    };
  }

  // ---- world summary & feed ---------------------------------------------------------------------

  summarize(p: PlayerRecord): BaseSummary {
    const raid = this.raidByPlot.get(p.plot) ?? 0;
    return {
      p: p.plot,
      id: p.id,
      name: p.name,
      hq: p.base.hq,
      walls: p.base.walls,
      posts: p.base.posts.map((s) => (s ? [POST_TYPES.indexOf(s.type), s.level] : null)),
      trophies: this.admin.frozen ? (this.admin.frozen[p.id] ?? 0) : p.trophies,
      shield: p.shieldUntil > this.now() ? p.shieldUntil : 0,
      immune: p.immuneUntil > this.now() ? p.immuneUntil : 0,
      raid,
      ...(raid ? { raider: this.players.get(this.raids.get(raid)!.attackerId)!.name } : {}),
      wave: this.summaries.get(p.plot)?.wave ?? 0,
      // Rounded so every zombie kill doesn't ripple out to every client.
      loot: Math.floor(lootable(p.coins, p.base.hq) / 10) * 10,
    };
  }

  private setWaveFlag(plot: number, wave: 0 | 1 | 2) {
    const s = this.summaries.get(plot);
    if (s && s.wave !== wave) {
      s.wave = wave;
      this.dirty.add(plot);
    }
  }

  markDirty(plot: number) {
    this.dirty.add(plot);
  }

  /** Every claimed base, for a screen that just connected. */
  worldSummary(): BaseSummary[] {
    return [...this.players.values()].map((p) => {
      const s = this.summarize(p);
      this.summaries.set(p.plot, s);
      return s;
    });
  }

  /** Send the bases that changed since the last flush (twice a second). */
  flushSummaries() {
    if (!this.dirty.size) return;
    const changed: BaseSummary[] = [];
    for (const plot of this.dirty) {
      const p = this.ownerOf(plot);
      if (!p) continue;
      const next = this.summarize(p);
      const prev = this.summaries.get(plot);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) changed.push(next);
      this.summaries.set(plot, next);
    }
    this.dirty.clear();
    if (changed.length) this.out.toAll('world', { bases: changed, now: this.now() });
  }

  private pushFeed(text: string, kind: FeedItem['kind']) {
    const item: FeedItem = { t: this.now(), text, kind };
    this.feed.push(item);
    if (this.feed.length > FEED_KEEP) this.feed.shift();
    this.out.toAll('feed', item);
  }
}
