import { randomBytes } from 'node:crypto';
import {
  CONFIG,
  ZombieWave,
  applyAction,
  breachLoss,
  newBase,
  parseAction,
  quote,
  type BaseState,
  type OfflineSummary,
  type PlayerView,
  type Snapshot,
} from '@siege/shared';
import type { PlayerRecord, Store } from './store.ts';

// The authoritative game. Owns every player's state in memory, writes each change straight to the
// store, runs live zombie waves for online players and resolves waves headlessly for offline ones.
// It knows nothing about sockets: it talks to clients through `Outbox`.

export class GameError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface Outbox {
  /** Send to every connected screen of one player. */
  toPlayer(id: number, event: string, data: unknown): void;
}

export interface WaveInfo {
  phase: 'calm' | 'wave';
  /** Seconds until the next wave (calm only). */
  nextIn?: number;
  sides?: string[];
  /** The base layout the current wave is being fought on. */
  base?: BaseState;
  snapshot?: Snapshot;
}

interface Live {
  phase: 'calm' | 'wave';
  calmUntil: number; // server tick
  wave: ZombieWave | null;
}

const emptyOffline = (): OfflineSummary => ({ waves: 0, breaches: 0, coinsEarned: 0, coinsLost: 0, capped: false });

/** Hash two ints into a 32-bit seed. */
function seedOf(id: number, n: number): number {
  let h = Math.imul(id ^ 0x5bd1e995, 0x01000193) ^ n;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 12)) >>> 0;
}

export class GameServer {
  readonly players = new Map<number, PlayerRecord>();
  private byRoll = new Map<string, number>();
  private byToken = new Map<string, number>();
  private sockets = new Map<number, number>();
  private live = new Map<number, Live>();
  private nextOffline = new Map<number, number>();
  /** Server ticks since start (CONFIG.tickRate per second). */
  tickNo = 0;

  constructor(private readonly store: Store, private readonly out: Outbox, private readonly now: () => number = Date.now) {
    const t = now();
    for (const p of store.loadPlayers()) {
      this.index(p);
      // Spread the first offline waves out so a restart doesn't run every base at once.
      this.nextOffline.set(p.id, t + CONFIG.offline.waveEvery * 1000 * Math.random());
    }
  }

  private index(p: PlayerRecord) {
    this.players.set(p.id, p);
    this.byRoll.set(p.roll, p.id);
    this.byToken.set(p.token, p.id);
  }

  private save(p: PlayerRecord) {
    this.store.savePlayer(p);
  }

  view(p: PlayerRecord): PlayerView {
    return { id: p.id, name: p.name, roll: p.roll, coins: p.coins, trophies: p.trophies, base: p.base };
  }

  isOnline(id: number) {
    return (this.sockets.get(id) ?? 0) > 0;
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
      if (p.name.toLowerCase() !== name.toLowerCase()) {
        throw new GameError('roll_taken', 'That roll number is registered under a different name');
      }
      return p;
    }
    const t = this.now();
    const p = this.store.savePlayer({
      roll,
      name,
      token: randomBytes(24).toString('base64url'),
      coins: CONFIG.start.coins,
      trophies: 0,
      base: newBase(),
      bank: 0,
      offline: emptyOffline(),
      waveNo: 0,
      createdAt: t,
      lastSeen: t,
    });
    this.index(p);
    this.nextOffline.set(p.id, t + CONFIG.offline.waveEvery * 1000);
    return p;
  }

  resume(token: unknown): PlayerRecord | null {
    const id = this.byToken.get(String(token ?? ''));
    return id === undefined ? null : this.players.get(id)!;
  }

  // ---- presence ---------------------------------------------------------------------------------

  /** A screen connected. The first one credits the offline bank and starts live waves. */
  connect(id: number): { player: PlayerView; offline: (OfflineSummary & { credited: number }) | null; wave: WaveInfo } {
    const p = this.players.get(id)!;
    const n = (this.sockets.get(id) ?? 0) + 1;
    this.sockets.set(id, n);
    let offline: (OfflineSummary & { credited: number }) | null = null;
    if (n === 1) {
      if (p.offline.waves > 0 || p.bank > 0) offline = { ...p.offline, credited: p.bank };
      p.coins += p.bank;
      p.bank = 0;
      p.offline = emptyOffline();
      p.lastSeen = this.now();
      this.save(p);
      this.nextOffline.delete(id);
      // First wave comes quickly so there's something to watch.
      this.live.set(id, { phase: 'calm', calmUntil: this.tickNo + 3 * CONFIG.tickRate, wave: null });
    }
    return { player: this.view(p), offline, wave: this.waveInfo(id) };
  }

  disconnect(id: number) {
    const n = Math.max(0, (this.sockets.get(id) ?? 0) - 1);
    this.sockets.set(id, n);
    if (n > 0) return;
    const p = this.players.get(id);
    const l = this.live.get(id);
    this.live.delete(id);
    if (!p) return;
    // Finish a running wave headlessly so its outcome still counts.
    if (l?.wave && !l.wave.done) {
      const before = l.wave.coins;
      l.wave.runToEnd();
      p.coins += l.wave.coins - before;
      this.settle(p, l.wave, false);
    }
    p.lastSeen = this.now();
    this.save(p);
    this.nextOffline.set(id, this.now() + CONFIG.offline.waveEvery * 1000);
  }

  waveInfo(id: number): WaveInfo {
    const l = this.live.get(id);
    if (!l) return { phase: 'calm' };
    if (l.phase === 'calm' || !l.wave) return { phase: 'calm', nextIn: Math.max(0, (l.calmUntil - this.tickNo) / CONFIG.tickRate) };
    return { phase: 'wave', sides: l.wave.plan.sides, base: l.wave.base, snapshot: l.wave.combat.snapshot(true) };
  }

  // ---- actions ----------------------------------------------------------------------------------

  /** Build or upgrade. Changes take effect from the next wave. */
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
    return this.view(p);
  }

  // ---- simulation -------------------------------------------------------------------------------

  /** Advance one server tick: live waves for online players, headless waves for offline ones. */
  tick() {
    this.tickNo++;
    for (const [id, l] of this.live) this.tickLive(id, l);
    if (this.tickNo % CONFIG.tickRate === 0) this.tickOffline(5);
  }

  private tickLive(id: number, l: Live) {
    const p = this.players.get(id)!;
    if (l.phase === 'calm') {
      if (this.tickNo < l.calmUntil) return;
      p.waveNo++;
      this.save(p);
      l.wave = new ZombieWave(p.base, seedOf(p.id, p.waveNo));
      l.phase = 'wave';
      this.out.toPlayer(id, 'wave', this.waveInfo(id));
      return;
    }
    const w = l.wave!;
    const earned = w.step();
    if (earned > 0) {
      p.coins += earned;
      this.save(p);
      this.out.toPlayer(id, 'coins', { coins: p.coins, delta: earned });
    }
    if (w.combat.tick % CONFIG.snapshotEvery === 0 || w.done) this.out.toPlayer(id, 'snap', w.combat.snapshot());
    if (w.done) {
      this.settle(p, w, true);
      l.phase = 'calm';
      l.wave = null;
      l.calmUntil = this.tickNo + CONFIG.waves.calm * CONFIG.tickRate;
      this.out.toPlayer(id, 'wave', this.waveInfo(id));
    }
  }

  /** Apply the end of a wave the player was watching (kill coins are already credited). */
  private settle(p: PlayerRecord, w: ZombieWave, notify: boolean) {
    const lost = w.breached ? breachLoss(p.coins) : 0;
    p.coins -= lost;
    this.save(p);
    if (notify) this.out.toPlayer(p.id, 'waveEnd', { breached: w.breached, kills: w.kills, coins: w.coins, lost, total: p.coins });
  }

  /** Resolve due offline waves (at most `budget` per call, to keep each tick cheap). */
  tickOffline(budget: number) {
    const t = this.now();
    for (const [id, due] of this.nextOffline) {
      if (budget <= 0) break;
      if (due > t || this.isOnline(id)) continue;
      const p = this.players.get(id);
      if (!p) continue;
      budget--;
      this.runOfflineWave(p);
      this.nextOffline.set(id, t + CONFIG.offline.waveEvery * 1000);
    }
  }

  runOfflineWave(p: PlayerRecord) {
    p.waveNo++;
    const w = new ZombieWave(p.base, seedOf(p.id, p.waveNo));
    w.runToEnd();
    const room = Math.max(0, CONFIG.offline.bankCap - p.bank);
    const banked = Math.min(room, w.coins);
    p.bank += banked;
    const lost = w.breached ? breachLoss(p.coins) : 0;
    p.coins -= lost;
    p.offline = {
      waves: p.offline.waves + 1,
      breaches: p.offline.breaches + (w.breached ? 1 : 0),
      coinsEarned: p.offline.coinsEarned + banked,
      coinsLost: p.offline.coinsLost + lost,
      capped: p.offline.capped || banked < w.coins,
    };
    this.save(p);
  }
}
