import type { Server, Socket } from 'socket.io';
import { GameError, type GameServer } from './game.ts';

// Socket protocol. Clients only send intents; every number comes from the server.
//
//  client -> server                         server -> client
//  login {name, roll} (ack)                 welcome {token, player, offline, feed}
//  act {kind, slot?, type?} (ack)           world {bases, now}         (full on connect, then changes)
//  watch {plots: number[]}                  live BaseLive              (when a watched base is joined)
//  attack {plot} (ack)                      wave BaseLive / snap {p, ...Snapshot} / waveEnd
//  deploy {kind, x, y} (ack)                raid RaidStatus / raidEnd RaidResult / underAttack
//  retreat                                  coins {coins, delta} / player PlayerView / feed FeedItem
//  tap {x, y}  (no ack: hits arrive as tap) tap {p, ...TapResult} (everyone watching) / airstrike {p, x, y, delay}
//  airstrike {x, y} (ack) / reload          siege {p, ...SiegeEvent} / pressure {sides, hq, ammo, ...} (owner)
//  mode {mode: 'pve' | 'pvp'} (ack)
//  immunity {minutes} (ack)                 crate CrateView            (a new crate, or it was claimed)
//  answer {crate, answer} (ack)             status {paused, frozen}    (organiser switches)
//  logout                                   needLogin
//
// "Watching" = area of interest: a screen only gets live combat for the bases it's looking at
// (at most MAX_WATCH, plus its own base, which it always watches).
//
// Spectators (the Live Arena, the projector) connect with auth {spectator: true} and no login. They
// get the world summary, feed and crate, and may watch up to MAX_SPECTATE bases. They can't act.

type Ack = (res: { ok: true; [k: string]: unknown } | { ok: false; error: string }) => void;

const MAX_WATCH = 6;
const MAX_SPECTATE = 2;
const room = (plot: number) => `base:${plot}`;

function limiter(burst: number, perSec: number) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * perSec);
    last = now;
    if (tokens < 1) return false;
    tokens--;
    return true;
  };
}

/** Handles the admin layer needs on live connections. */
export interface Sessions {
  /** Log a player out on every screen (before deleting their account). */
  kick(playerId: number): void;
  /** Connected screens: players and spectators. */
  counts(): { players: number; spectators: number };
}

export function attachSockets(io: Server, game: GameServer): Sessions {
  const sessions = new Map<Socket, { playerId: () => number | null; spectator: boolean; kick: () => void }>();
  io.on('connection', (socket: Socket) => {
    let playerId: number | null = null;
    let ownPlot: number | null = null;
    const watching = new Set<number>();
    const allowAct = limiter(10, 5);
    const allowDeploy = limiter(12, 8);
    // Answers are also rate-limited per player inside the game (wrong-answer cooldowns).
    const allowAnswer = limiter(4, 1);
    const reply = (ack: unknown, res: Parameters<Ack>[0]) => {
      if (typeof ack === 'function') (ack as Ack)(res);
    };
    const fail = (ack: unknown, e: unknown) => reply(ack, { ok: false, error: e instanceof GameError ? e.message : 'Something went wrong' });

    const startWatching = (plot: number) => {
      if (watching.has(plot)) return;
      watching.add(plot);
      void socket.join(room(plot));
      game.watch(plot, 1);
      socket.emit('live', game.baseLive(plot));
    };
    const stopWatching = (plot: number) => {
      if (!watching.delete(plot)) return;
      void socket.leave(room(plot));
      game.watch(plot, -1);
    };

    const attach = (id: number) => {
      const p = game.players.get(id)!;
      playerId = id;
      ownPlot = p.plot;
      void socket.join(`p:${id}`);
      const w = game.connect(id);
      socket.emit('welcome', { token: p.token, ...w });
      socket.emit('world', { bases: game.worldSummary(), now: Date.now(), full: true, raids: game.liveRaids() });
      socket.emit('status', game.status());
      startWatching(p.plot);
    };
    const detach = () => {
      for (const plot of [...watching]) stopWatching(plot);
      if (playerId === null) return;
      void socket.leave(`p:${playerId}`);
      game.disconnect(playerId);
      playerId = null;
      ownPlot = null;
    };

    // Reconnects (and returning visitors) present their saved token.
    const auth = (socket.handshake.auth ?? {}) as { token?: unknown; spectator?: unknown };
    const spectator = auth.spectator === true;
    const resumed = spectator ? null : game.resume(auth.token);
    if (resumed) attach(resumed.id);
    else if (spectator) {
      socket.emit('world', { bases: game.worldSummary(), now: Date.now(), full: true, raids: game.liveRaids() });
      socket.emit('arena', { feed: game.feed.slice(-10), crate: game.crateView() });
      socket.emit('status', game.status());
    } else socket.emit('needLogin');

    socket.on('login', (data: unknown, ack: unknown) => {
      if (spectator) return reply(ack, { ok: false, error: 'Spectators can only watch' });
      if (!allowAct()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        const d = (data ?? {}) as { name?: unknown; roll?: unknown };
        const p = game.login(d.name, d.roll);
        detach();
        attach(p.id);
        reply(ack, { ok: true, token: p.token });
      } catch (e) {
        fail(ack, e);
      }
    });

    socket.on('act', (data: unknown, ack: unknown) => {
      if (playerId === null) return reply(ack, { ok: false, error: 'Not logged in' });
      if (!allowAct()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        reply(ack, { ok: true, player: game.act(playerId, data) });
      } catch (e) {
        fail(ack, e);
      }
    });

    /** The plots this screen is currently looking at (closest first). */
    socket.on('watch', (data: unknown) => {
      if (playerId === null && !spectator) return;
      const max = spectator ? MAX_SPECTATE : MAX_WATCH;
      const raw = Array.isArray((data as { plots?: unknown })?.plots) ? ((data as { plots: unknown[] }).plots) : [];
      const want = new Set<number>();
      for (const v of raw) {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 0 && n < 64) want.add(n);
        if (want.size >= max) break;
      }
      if (ownPlot !== null) want.add(ownPlot);
      for (const plot of [...watching]) if (!want.has(plot)) stopWatching(plot);
      for (const plot of want) startWatching(plot);
    });

    socket.on('attack', (data: unknown, ack: unknown) => {
      if (playerId === null) return reply(ack, { ok: false, error: 'Not logged in' });
      if (!allowAct()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        const plot = Number((data as { plot?: unknown })?.plot);
        const raid = game.attack(playerId, plot);
        startWatching(plot);
        reply(ack, { ok: true, raid });
      } catch (e) {
        fail(ack, e);
      }
    });

    socket.on('deploy', (data: unknown, ack: unknown) => {
      if (playerId === null) return reply(ack, { ok: false, error: 'Not logged in' });
      if (!allowDeploy()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        const d = (data ?? {}) as { kind?: unknown; x?: unknown; y?: unknown };
        reply(ack, { ok: true, ...game.deploy(playerId, d.kind, d.x, d.y) });
      } catch (e) {
        fail(ack, e);
      }
    });

    socket.on('retreat', () => {
      if (playerId !== null) game.retreat(playerId);
    });

    // Taps come fast: the game enforces the fire rate; this only drops floods before they reach it.
    const allowTap = limiter(12, 8);
    socket.on('tap', (data: unknown) => {
      if (playerId === null || !allowTap()) return;
      const d = (data ?? {}) as { x?: unknown; y?: unknown };
      game.tap(playerId, d.x, d.y);
    });
    socket.on('callEarly', (_data: unknown, ack: unknown) => {
      if (playerId === null) return reply(ack, { ok: false, error: 'Not logged in' });
      if (!allowAct()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        reply(ack, { ok: true, ...game.callEarly(playerId) });
      } catch (e) {
        fail(ack, e);
      }
    });
    socket.on('reload', () => {
      if (playerId !== null) game.reload(playerId);
    });
    socket.on('airstrike', (data: unknown, ack: unknown) => {
      if (playerId === null) return reply(ack, { ok: false, error: 'Not logged in' });
      if (!allowAct()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        const d = (data ?? {}) as { x?: unknown; y?: unknown };
        reply(ack, { ...game.airstrike(playerId, d.x, d.y) });
      } catch (e) {
        fail(ack, e);
      }
    });

    socket.on('mode', (data: unknown, ack: unknown) => {
      if (playerId === null) return reply(ack, { ok: false, error: 'Not logged in' });
      if (!allowAct()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        reply(ack, { ok: true, player: game.setMode(playerId, (data as { mode?: unknown })?.mode) });
      } catch (e) {
        fail(ack, e);
      }
    });

    socket.on('immunity', (data: unknown, ack: unknown) => {
      if (playerId === null) return reply(ack, { ok: false, error: 'Not logged in' });
      if (!allowAct()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        reply(ack, { ok: true, player: game.buyImmunity(playerId, (data as { minutes?: unknown })?.minutes) });
      } catch (e) {
        fail(ack, e);
      }
    });

    socket.on('answer', (data: unknown, ack: unknown) => {
      if (playerId === null) return reply(ack, { ok: false, error: 'Not logged in' });
      if (!allowAnswer()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        const d = (data ?? {}) as { crate?: unknown; answer?: unknown };
        reply(ack, { ok: true, ...game.answer(playerId, d.crate, d.answer) });
      } catch (e) {
        fail(ack, e);
      }
    });

    socket.on('logout', () => {
      detach();
      socket.emit('needLogin');
    });

    sessions.set(socket, {
      playerId: () => playerId,
      spectator,
      kick: () => {
        detach();
        socket.emit('needLogin');
      },
    });
    socket.on('disconnect', () => {
      detach();
      sessions.delete(socket);
    });
  });

  return {
    kick(id) {
      for (const s of sessions.values()) if (s.playerId() === id) s.kick();
    },
    counts() {
      let players = 0;
      let spectators = 0;
      for (const s of sessions.values()) {
        if (s.spectator) spectators++;
        else if (s.playerId() !== null) players++;
      }
      return { players, spectators };
    },
  };
}
