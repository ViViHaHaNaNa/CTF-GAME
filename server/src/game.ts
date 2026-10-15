import { randomBytes } from 'node:crypto';
import {
  CONFIG,
  POST_TYPES,
  Raid,
  ZombieWave,
  applyAction,
  breachLoss,
  getWorld,
  isRaiderKind,
  lootable,
  newBase,
  parseAction,
  quote,
  trophyStake,
  weakerFactor,
  type BaseSummary,
  type FeedItem,
  type OfflineSummary,
  type PlayerView,
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
  readonly feed: FeedItem[] = [];
  /** Server ticks since start (CONFIG.tickRate per second). */
  tickNo = 0;

  constructor(private readonly store: Store, private readonly out: Outbox, private readonly now: () => number = Date.now) {
    const t = now();
    for (const p of store.loadPlayers()) {
      // Records from before the shared world get a plot (and the new fields) on load.
      p.shieldUntil ??= 0;
      if (p.plot === undefined || this.byPlot.has(p.plot)) {
        p.plot = this.freePlot();
        this.save(p);
      }
      this.index(p);
      // Spread the first offline waves out so a restart doesn't run every base at once.
      this.nextOffline.set(p.id, t + CONFIG.offline.waveEvery * 1000 * Math.random());
    }
    for (const p of this.players.values()) this.summaries.set(p.plot, this.summarize(p));
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
    return { id: p.id, name: p.name, roll: p.roll, coins: p.coins, trophies: p.trophies, plot: p.plot, base: p.base, shieldUntil: p.shieldUntil };
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
  connect(id: number): { player: PlayerView; offline: (OfflineSummary & { credited: number }) | null; feed: FeedItem[] } {
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
    return { player: this.view(p), offline, feed: this.feed.slice(-10) };
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
    return null;
  }

  attack(attackerId: number, plot: number): RaidStatus {
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
    const id = ++this.raidSeq;
    const raid = new Raid(id, getWorld().plots[plot]!, d.base, a.base.hq, seedOf(id, this.tickNo));
    const r: RaidState = { raid, attackerId: a.id, defenderId: d.id, spent: 0 };
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
    this.tickNo++;
    for (const [plot, l] of this.live) this.tickLive(plot, l);
    for (const r of this.raids.values()) this.tickRaid(r);
    if (this.tickNo % CONFIG.tickRate === 0) this.tickOffline(5);
    if (this.tickNo % (CONFIG.tickRate / 2) === 0) this.flushSummaries();
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
      l.wave = new ZombieWave(p.base, seedOf(p.id, p.waveNo), getWorld().plots[plot]!);
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
    let loot = 0;
    let trophies = 0;
    if (raid.won) {
      loot = Math.round(lootable(d.coins, d.base.hq) * weakerFactor(a.trophies, d.trophies));
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
    const w = new ZombieWave(p.base, seedOf(p.id, p.waveNo), getWorld().plots[p.plot]!);
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
      trophies: p.trophies,
      shield: p.shieldUntil > this.now() ? p.shieldUntil : 0,
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
