import type { Server, Socket } from 'socket.io';
import { GameError, type GameServer } from './game.ts';

// Socket protocol. Clients only send intents ("login", "act"); every number comes from the server.
//
//  client -> server                       server -> client
//  login {name, roll} (ack)               welcome {token, player, offline, wave}
//  act {kind, slot?, type?} (ack)         needLogin
//  logout                                 wave {phase, nextIn | sides, base, snapshot}
//                                         snap Snapshot (10/s during a wave)
//                                         coins {coins, delta}
//                                         waveEnd {breached, kills, coins, lost, total}

type Ack = (res: { ok: true; [k: string]: unknown } | { ok: false; error: string }) => void;

const RATE = { burst: 10, perSec: 5 };

export function attachSockets(io: Server, game: GameServer) {
  io.on('connection', (socket: Socket) => {
    let playerId: number | null = null;
    let tokens = RATE.burst;
    let last = Date.now();
    const allow = () => {
      const now = Date.now();
      tokens = Math.min(RATE.burst, tokens + ((now - last) / 1000) * RATE.perSec);
      last = now;
      if (tokens < 1) return false;
      tokens--;
      return true;
    };
    const reply = (ack: unknown, res: Parameters<Ack>[0]) => {
      if (typeof ack === 'function') (ack as Ack)(res);
    };

    const attach = (id: number) => {
      const p = game.players.get(id)!;
      playerId = id;
      void socket.join(`p:${id}`);
      const w = game.connect(id);
      socket.emit('welcome', { token: p.token, ...w });
    };
    const detach = () => {
      if (playerId === null) return;
      void socket.leave(`p:${playerId}`);
      game.disconnect(playerId);
      playerId = null;
    };

    // Reconnects (and returning visitors) present their saved token.
    const resumed = game.resume((socket.handshake.auth as { token?: unknown } | undefined)?.token);
    if (resumed) attach(resumed.id);
    else socket.emit('needLogin');

    socket.on('login', (data: unknown, ack: unknown) => {
      if (!allow()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        const d = (data ?? {}) as { name?: unknown; roll?: unknown };
        const p = game.login(d.name, d.roll);
        detach();
        attach(p.id);
        reply(ack, { ok: true, token: p.token });
      } catch (e) {
        reply(ack, { ok: false, error: e instanceof GameError ? e.message : 'Login failed' });
      }
    });

    socket.on('act', (data: unknown, ack: unknown) => {
      if (playerId === null) return reply(ack, { ok: false, error: 'Not logged in' });
      if (!allow()) return reply(ack, { ok: false, error: 'Slow down a little' });
      try {
        reply(ack, { ok: true, player: game.act(playerId, data) });
      } catch (e) {
        reply(ack, { ok: false, error: e instanceof GameError ? e.message : 'Something went wrong' });
      }
    });

    socket.on('logout', () => {
      detach();
      socket.emit('needLogin');
    });

    socket.on('disconnect', detach);
  });
}
