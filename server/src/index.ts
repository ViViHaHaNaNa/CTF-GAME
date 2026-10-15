import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { CONFIG, type Question } from '@siege/shared';
import { GameServer } from './game.ts';
import { attachSockets } from './net.ts';
import { SqliteStore } from './store.ts';

// One process: the game (socket.io) plus, in production, the built website.
// Binds 0.0.0.0 so phones on the venue wifi can reach it; prints the LAN URL at startup.

const PORT = Number(process.env.SIEGE_PORT ?? 3000);
const HOST = process.env.SIEGE_HOST ?? '0.0.0.0';
const DB_FILE = process.env.SIEGE_DB ?? join(import.meta.dirname, '../data/siege.db');
const CLIENT_DIST = join(import.meta.dirname, '../../client/dist');

const QUESTIONS_FILE = process.env.SIEGE_QUESTIONS ?? join(import.meta.dirname, '../data/questions.json');
const questions = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8')) as Question[];

const store = new SqliteStore(DB_FILE);
const app = Fastify({ logger: false });
const io = new Server(app.server, {
  // The site may be served from elsewhere later (cloud); the game server stays its own origin.
  cors: { origin: true },
  pingInterval: 10_000,
  pingTimeout: 8_000,
});
const game = new GameServer(store, {
  toPlayer: (id, ev, data) => io.to(`p:${id}`).emit(ev, data),
  toBase: (plot, ev, data) => io.to(`base:${plot}`).emit(ev, data),
  toAll: (ev, data) => io.emit(ev, data),
}, Date.now, questions);
attachSockets(io, game);

app.get('/api/health', async () => ({ ok: true, players: game.players.size }));

if (existsSync(join(CLIENT_DIST, 'index.html'))) {
  await app.register(fastifyStatic, { root: CLIENT_DIST });
  // /siege/arena... loads the Live Arena; every other /siege/... route loads the game page.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/siege/arena')) return reply.sendFile('siege/arena/index.html');
    if (req.url.startsWith('/siege')) return reply.sendFile('siege/index.html');
    return reply.code(404).send('Not found');
  });
}

// Fixed-rate game loop; catches up if the event loop stalls (bounded so it never spirals).
const tickMs = 1000 / CONFIG.tickRate;
let next = performance.now();
const loop = setInterval(() => {
  const now = performance.now();
  let n = 0;
  while (now >= next && n < 5) {
    game.tick();
    next += tickMs;
    n++;
  }
  if (now - next > 1000) next = now; // fell far behind (laptop slept): don't replay it all
}, tickMs / 2);

await app.listen({ port: PORT, host: HOST });
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => i!.address);
const served = existsSync(join(CLIENT_DIST, 'index.html'));
// In dev the site is served by Vite (port 5173), not by this process.
const sitePort = served ? PORT : Number(process.env.SIEGE_DEV_PORT ?? 5173);
console.log(`\n  Code Siege game server on port ${PORT} (${game.players.size} players, ${questions.length} crate questions)${served ? '' : ' [dev: site served by Vite]'}`);
console.log(`  This laptop: http://localhost:${sitePort}/siege/`);
for (const ip of lan) console.log(`  LAN:         http://${ip}:${sitePort}/siege/`);
console.log('');

function shutdown() {
  clearInterval(loop);
  io.close();
  void app.close().finally(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
