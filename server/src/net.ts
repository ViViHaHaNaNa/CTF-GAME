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
//  logout                                   needLogin
//
// "Watching" = area of interest: a screen only gets live combat for the bases it's looking at
// (at most MAX_WATCH, plus its own base, which it always watches).

type Ack = (res: { ok: true; [k: string]: unknown } | { ok: false; error: string }) => void;

const MAX_WATCH = 6;
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

export function attachSockets(io: Server, game: GameServer) {
  io.on('connection', (socket: Socket) => {
    let playerId: number | null = null;
    let ownPlot: number | null = null;
    const watching = new Set<number>();
    const allowAct = limiter(10, 5);
    const allowDeploy = limiter(12, 8);
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
    const resumed = game.resume((socket.handshake.auth as { token?: unknown } | undefined)?.token);
    if (resumed) attach(resumed.id);
    else socket.emit('needLogin');

    socket.on('login', (data: unknown, ack: unknown) => {
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
      if (playerId === null) return;
      const raw = Array.isArray((data as { plots?: unknown })?.plots) ? ((data as { plots: unknown[] }).plots) : [];
      const want = new Set<number>();
      for (const v of raw) {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 0 && n < 64) want.add(n);
        if (want.size >= MAX_WATCH) break;
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

    socket.on('logout', () => {
      detach();
      socket.emit('needLogin');
    });

    socket.on('disconnect', detach);
  });
}
