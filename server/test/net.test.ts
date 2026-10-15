import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { GameServer } from '../src/game.ts';
import { attachSockets } from '../src/net.ts';
import { SqliteStore } from '../src/store.ts';

// Real sockets end to end: the spectator (Live Arena) connection.

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

async function start() {
  const http = createServer();
  const io = new Server(http);
  const game = new GameServer(new SqliteStore(':memory:'), {
    toPlayer: (id, ev, data) => io.to(`p:${id}`).emit(ev, data),
    toBase: (plot, ev, data) => io.to(`base:${plot}`).emit(ev, data),
    toAll: (ev, data) => io.emit(ev, data),
  });
  const sessions = attachSockets(io, game);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  cleanup.push(() => {
    io.close();
    http.close();
  });
  return { game, url, sessions };
}

function client(url: string, auth: object): Socket {
  const s = connect(url, { auth, transports: ['websocket'], reconnection: false });
  cleanup.push(() => s.close());
  return s;
}

const next = <T>(s: Socket, ev: string) => new Promise<T>((r) => s.once(ev, r));

describe('spectator sockets', () => {
  it('get the world and feed without logging in, can watch a base, and cannot act', async () => {
    const { game, url } = await start();
    const p = game.login('Owner', 'S1001');
    const s = client(url, { spectator: true });
    const [world, arena] = await Promise.all([next<{ full: boolean; bases: { name: string }[] }>(s, 'world'), next<{ feed: unknown[] }>(s, 'arena')]);
    expect(world.full).toBe(true);
    expect(world.bases.map((b) => b.name)).toEqual(['Owner']);
    expect(arena.feed.length).toBeGreaterThan(0);

    const live = next<{ p: number }>(s, 'live');
    s.emit('watch', { plots: [p.plot, 1, 2, 3] });
    expect((await live).p).toBe(p.plot);

    const res = await new Promise<{ ok: boolean; error?: string }>((r) => s.emit('login', { name: 'Sneaky', roll: 'S2002' }, r));
    expect(res.ok).toBe(false);
    const act = await new Promise<{ ok: boolean }>((r) => s.emit('act', { kind: 'hq' }, r));
    expect(act.ok).toBe(false);
    expect(game.players.size).toBe(1);
  });

  it('without the spectator flag (and no token) a socket is asked to log in', async () => {
    const { url } = await start();
    const s = client(url, {});
    await next(s, 'needLogin');
  });
});

describe('reconnects', () => {
  it('a player who drops comes back as the same player, still in their raid', async () => {
    const { game, url } = await start();
    const d = game.login('Defender', 'R1002');
    const first = client(url, {});
    await next(first, 'needLogin');
    const res = await new Promise<{ ok: boolean; token: string }>((r) => first.emit('login', { name: 'Raider', roll: 'R1001' }, r));
    expect(res.ok).toBe(true);
    const attacked = await new Promise<{ ok: boolean }>((r) => first.emit('attack', { plot: d.plot }, r));
    expect(attacked.ok).toBe(true);
    first.close();

    // A new connection with the saved token: no login screen, same player, raid still on.
    const again = client(url, { token: res.token });
    const [welcome, world] = await Promise.all([
      next<{ player: { name: string } }>(again, 'welcome'),
      next<{ raids: { attacker: string; plot: number }[] }>(again, 'world'),
    ]);
    expect(welcome.player.name).toBe('Raider');
    expect(world.raids).toMatchObject([{ attacker: 'Raider', plot: d.plot }]);
  });

  it('a deleted player is sent back to the login screen on every open screen', async () => {
    const { game, url, sessions } = await start();
    const p = game.login('Gone', 'R2001');
    const s = client(url, { token: p.token });
    await next(s, 'welcome');
    const kicked = next(s, 'needLogin');
    sessions.kick(p.id);
    game.deletePlayer(p.id);
    await kicked;
    expect(sessions.counts().players).toBe(0);
  });
});
