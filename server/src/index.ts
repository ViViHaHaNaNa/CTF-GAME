import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { Server } from 'socket.io';
import { CONFIG, type Question } from '@siege/shared';
import { GameServer } from './game.ts';
import { registerAdmin } from './admin.ts';
import { attachSockets } from './net.ts';
import { SqliteStore } from './store.ts';

// One process: the game (socket.io) plus, in production, the built website.
// Binds 0.0.0.0 so phones on the venue wifi can reach it; prints the LAN URL at startup.

// Optional settings file (gitignored): server/.env, e.g. SIEGE_ADMIN_PASS=... (see .env.example).
// Real environment variables win over the file.
try {
  process.loadEnvFile(join(import.meta.dirname, '../.env'));
} catch {
  /* no .env file: defaults and real environment variables only */
}

const PORT = Number(process.env.SIEGE_PORT ?? 3000);
const HOST = process.env.SIEGE_HOST ?? '0.0.0.0';
const DB_FILE = process.env.SIEGE_DB ?? join(import.meta.dirname, '../data/siege.db');
const CLIENT_DIST = join(import.meta.dirname, '../../client/dist');

const ADMIN_PASS = process.env.SIEGE_ADMIN_PASS || undefined;
const BACKUP_DIR = process.env.SIEGE_BACKUPS ?? join(import.meta.dirname, '../data/backups');
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
const sessions = attachSockets(io, game);

// Loop health, measured over the last ~10 s: how long ticks take and how late the loop runs.
const health = { tickAvgMs: 0, tickMaxMs: 0, lagMaxMs: 0, ticks: 0, errors: 0, since: Date.now() };
let window10 = { sum: 0, n: 0, max: 0, lag: 0, at: performance.now() };
const stats = () => ({
  uptimeS: Math.round(process.uptime()),
  memoryMb: Math.round(process.memoryUsage().rss / 1e6),
  sockets: io.engine.clientsCount,
  tickAvgMs: health.tickAvgMs,
  tickMaxMs: health.tickMaxMs,
  loopLagMaxMs: health.lagMaxMs,
  tickErrors: health.errors,
  paused: game.paused,
});

app.get('/api/health', async () => ({ ok: true, players: game.players.size, ...stats() }));
registerAdmin(app, { game, sessions, store, passphrase: ADMIN_PASS, backupDir: BACKUP_DIR, stats });

if (existsSync(join(CLIENT_DIST, 'index.html'))) {
  await app.register(fastifyStatic, { root: CLIENT_DIST });
  // /siege/arena... loads the Live Arena; every other /siege/... route loads the game page.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/siege/arena')) return reply.sendFile('siege/arena/index.html');
    if (req.url.startsWith('/siege/admin')) return reply.sendFile('siege/admin/index.html');
    if (req.url.startsWith('/siege')) return reply.sendFile('siege/index.html');
    return reply.code(404).send('Not found');
  });
}

// Fixed-rate game loop; catches up if the event loop stalls (bounded so it never spirals).
const tickMs = 1000 / CONFIG.tickRate;
let next = performance.now();
const loop = setInterval(() => {
  const now = performance.now();
  window10.lag = Math.max(window10.lag, now - next);
  let n = 0;
  while (now >= next && n < 5) {
    const t0 = performance.now();
    try {
      game.tick();
    } catch (e) {
      // One bad tick must not take the whole event down: log it (sparingly) and carry on.
      if (health.errors++ < 20) console.error('[tick error]', e);
    }
    const ms = performance.now() - t0;
    window10.sum += ms;
    window10.n++;
    window10.max = Math.max(window10.max, ms);
    next += tickMs;
    n++;
  }
  if (now - next > 1000) next = now; // fell far behind (laptop slept): don't replay it all
  if (now - window10.at >= 10_000) {
    health.tickAvgMs = window10.n ? Math.round((window10.sum / window10.n) * 100) / 100 : 0;
    health.tickMaxMs = Math.round(window10.max * 100) / 100;
    health.lagMaxMs = Math.round(Math.max(0, window10.lag));
    health.ticks = window10.n;
    window10 = { sum: 0, n: 0, max: 0, lag: 0, at: now };
  }
}, tickMs / 2);

await app.listen({ port: PORT, host: HOST });
// Every IPv4 address with its adapter's name. Virtual adapters (WSL, Hyper-V, VPNs, VMs) are listed
// last and marked: phones on the venue wifi need the Wi-Fi/Ethernet one.
const VIRTUAL = /vethernet|wsl|hyper-v|virtual|vmware|vbox|docker|loopback|tailscale|zerotier|vpn/i;
const lan = Object.entries(networkInterfaces())
  .flatMap(([name, list]) => (list ?? []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => ({ name, address: i.address, virtual: VIRTUAL.test(name) })))
  .sort((a, b) => Number(a.virtual) - Number(b.virtual));
const served = existsSync(join(CLIENT_DIST, 'index.html'));
// In dev the site is served by Vite (port 5173), not by this process.
const sitePort = served ? PORT : Number(process.env.SIEGE_DEV_PORT ?? 5173);
console.log(`\n  Code Siege game server on port ${PORT} (${game.players.size} players, ${questions.length} crate questions)${served ? '' : ' [dev: site served by Vite]'}`);
console.log(`  This laptop: http://localhost:${sitePort}/siege/`);
for (const ip of lan) console.log(`  LAN:         http://${ip.address}:${sitePort}/siege/   (${ip.name}${ip.virtual ? ', virtual: phones cannot use this' : ''})`);
console.log(`  Live Arena:  /siege/arena/   Projector: /siege/arena/?projector=1`);
console.log(ADMIN_PASS ? `  Admin:       /siege/admin/ (passphrase from SIEGE_ADMIN_PASS)` : '  Admin:       off (set SIEGE_ADMIN_PASS to turn it on)');
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
