// Load test: ~50 simulated players on one server, the way the fest will use it.
//
//   npm run loadtest                       50 bots for 60 s against a throwaway server (safe)
//   npm run loadtest -- --clients 60 --seconds 120
//   npm run loadtest -- --url http://192.168.1.20:3000 --yes    against a running server
//                                          (creates LOAD#### accounts there: never on event day)
//
// Each bot logs in, watches nearby bases (like a real screen), upgrades, raids other bots and
// deploys raiders, answers crates, and now and then drops its connection and comes back.
// A few spectators watch raids like the Live Arena. At the end it prints latencies, server tick
// timing and memory, and checks every crate had exactly one winner.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { CONFIG, PLOT, RAIDER_KINDS, getWorld, inDeployZone, type BaseSummary, type CrateView, type Question } from '@siege/shared';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const CLIENTS = Number(opt('clients', '50'));
const SECONDS = Number(opt('seconds', '60'));
const SPECTATORS = Number(opt('spectators', '3'));
const EXTERNAL = args.includes('--url') ? opt('url', '') : '';
const ADMIN_PASS = 'loadtest-pass';
const ROOT = join(import.meta.dirname, '../..');
const world = getWorld();
const QUESTIONS = JSON.parse(readFileSync(join(ROOT, 'server/data/questions.json'), 'utf8')) as Question[];

if (EXTERNAL && !args.includes('--yes')) {
  console.error(`This would create ${CLIENTS} LOAD#### accounts on ${EXTERNAL}. Add --yes if that's really what you want.`);
  process.exit(1);
}

// ---- measurements ---------------------------------------------------------------------------------

const lat: Record<string, number[]> = { login: [], act: [], deploy: [], reconnect: [], answer: [] };
const errors = new Map<string, number>();
let received = 0;
/** Bytes of packed combat snapshots received by all screens. */
let snapBytes = 0;
let raidsStarted = 0;
let deploys = 0;
const crateWinners = new Map<number, string[]>();
const health: Record<string, number>[] = [];

const note = (msg: string) => errors.set(msg, (errors.get(msg) ?? 0) + 1);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]): T | undefined => xs[Math.floor(Math.random() * xs.length)];

/** Expected rejections (rules of the game), not failures. */
const NORMAL = /more coins|locked|Max|Main Tower|Empty slot|already has a post|Shielded|Immune|under attack|current raid|own base|not raiding|raid is over|Troop limit|Wait|Too late|gone|Slow down|level/i;

function ack<T>(s: Socket, ev: string, data: unknown, kind: string): Promise<({ ok: true } & T) | { ok: false; error: string } | null> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    s.timeout(8000).emit(ev, data, (err: Error | null, res: ({ ok: true } & T) | { ok: false; error: string }) => {
      if (err) {
        // A bot that dropped its own connection mid-call doesn't count against the server.
        if (s.connected) note(`${ev}: no answer within 8 s`);
        return resolve(null);
      }
      lat[kind]?.push(performance.now() - t0);
      if (!res.ok && !NORMAL.test(res.error)) note(`${ev}: ${res.error}`);
      resolve(res);
    });
  });
}

// ---- server ---------------------------------------------------------------------------------------

async function startServer(): Promise<{ url: string; child: ChildProcess; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'siege-load-'));
  const port = 3990 + Math.floor(Math.random() * 9);
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, SIEGE_PORT: String(port), SIEGE_HOST: '127.0.0.1', SIEGE_DB: join(dir, 'load.db'), SIEGE_ADMIN_PASS: ADMIN_PASS, SIEGE_BACKUPS: join(dir, 'backups') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr!.on('data', (d: Buffer) => process.stderr.write(`[server] ${d}`));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server did not start within 30 s')), 30_000);
    child.stdout!.on('data', (d: Buffer) => {
      if (d.toString().includes('game server on port')) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`Server exited early (${code})`)));
  });
  return { url: `http://127.0.0.1:${port}`, child, dir };
}

// ---- bots -----------------------------------------------------------------------------------------

const bases = new Map<number, BaseSummary>();
let crate: CrateView | null = null;

class Bot {
  socket!: Socket;
  token: string | null = null;
  id = -1;
  plot = -1;
  coins = 0;
  hq = 1;
  raiding: number | null = null;
  stopped = false;

  constructor(readonly n: number) {}

  get roll() {
    return `LOAD${String(this.n).padStart(4, '0')}`;
  }

  connect(url: string): Promise<void> {
    const t0 = performance.now();
    return new Promise((resolve) => {
      this.socket = io(url, { auth: { token: this.token }, transports: ['websocket'], reconnection: false, forceNew: true });
      const s = this.socket;
      s.onAny((ev: string, data: unknown) => {
      received++;
      if (ev === 'snap' && data && typeof (data as ArrayBuffer).byteLength === 'number') snapBytes += (data as ArrayBuffer).byteLength;
    });
      s.on('needLogin', async () => {
        const r = await ack<{ token: string }>(s, 'login', { name: `Bot ${this.n}`, roll: this.roll }, 'login');
        if (r?.ok) this.token = r.token;
      });
      s.on('welcome', (w: { player: { id: number; plot: number; coins: number; base: { hq: number } } }) => {
        if (this.token && performance.now() - t0 > 0 && this.id >= 0) lat.reconnect!.push(performance.now() - t0);
        this.id = w.player.id;
        this.plot = w.player.plot;
        this.coins = w.player.coins;
        this.hq = w.player.base.hq;
        this.watchAround();
        resolve();
      });
      s.on('world', (m: { bases: BaseSummary[]; full?: boolean; raids?: { attackerId: number; plot: number }[] }) => {
        if (this.n === 1) {
          if (m.full) bases.clear();
          for (const b of m.bases) bases.set(b.p, b);
        }
        if (m.raids) this.raiding = m.raids.find((r) => r.attackerId === this.id)?.plot ?? null;
      });
      s.on('coins', (c: { coins: number }) => (this.coins = c.coins));
      s.on('player', (p: { coins: number; base: { hq: number } }) => {
        this.coins = p.coins;
        this.hq = p.base.hq;
      });
      s.on('raidEnd', (r: { attacker: string }) => {
        if (r.attacker === `Bot ${this.n}`) this.raiding = null;
      });
      s.on('crate', (c: CrateView | null) => {
        if (this.n === 1) crate = c;
        if (c && !c.claimedBy) void this.answerCrate(c);
      });
      s.on('connect_error', () => {
        note('connect_error');
        resolve();
      });
    });
  }

  /** Like a real screen: the own base plus a few neighbours. */
  watchAround() {
    const me = world.plots[this.plot];
    if (!me) return;
    const near = world.plots
      .filter((p) => p.id !== this.plot)
      .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))
      .slice(0, 2 + Math.floor(Math.random() * 3))
      .map((p) => p.id);
    this.socket.emit('watch', { plots: near });
  }

  async answerCrate(c: CrateView) {
    // Most bots guess wrong; a handful know the answer and race each other for it.
    await sleep(rand(200, 1500));
    const q = QUESTIONS.find((x) => x.prompt === c.prompt && x.code === c.code);
    const right = this.n % 10 === 0 && q;
    const r = await ack<{ correct: boolean }>(this.socket, 'answer', { crate: c.id, answer: right ? q.answers[0] : `wrong ${this.n}` }, 'answer');
    if (r?.ok && r.correct) crateWinners.set(c.id, [...(crateWinners.get(c.id) ?? []), `Bot ${this.n}`]);
  }

  async upgrade() {
    const action = pick([{ kind: 'walls' }, { kind: 'hq' }, { kind: 'build', slot: 1, type: 'pistol' }, { kind: 'post', slot: 0 }, { kind: 'post', slot: 1 }]);
    await ack(this.socket, 'act', action, 'act');
  }

  async raid() {
    if (this.raiding !== null) return;
    const targets = [...bases.values()].filter((b) => b.id !== this.id && !b.raid && b.shield < Date.now() && b.immune < Date.now());
    const t = pick(targets);
    if (!t) return;
    const r = await ack(this.socket, 'attack', { plot: t.p }, 'act');
    if (!r?.ok) return;
    raidsStarted++;
    this.raiding = t.p;
    const p = world.plots[t.p]!;
    const spots: [number, number][] = [];
    for (let y = 0; y < PLOT; y++) for (let x = 0; x < PLOT; x++) if (inDeployZone(x, y)) spots.push([p.x + x + 0.5, p.y + y + 0.5]);
    const n = 4 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n && !this.stopped; i++) {
      const [x, y] = pick(spots)!;
      const res = await ack(this.socket, 'deploy', { kind: pick(RAIDER_KINDS.filter((k) => CONFIG.pvp.raiders[k].unlockHq <= this.hq)), x, y }, 'deploy');
      if (res?.ok) deploys++;
      await sleep(rand(150, 500));
    }
  }

  async reconnect(url: string) {
    this.socket.close();
    await sleep(rand(200, 1500));
    if (!this.stopped) await this.connect(url);
  }

  async run(url: string, until: number) {
    while (!this.stopped && Date.now() < until) {
      const r = Math.random();
      if (r < 0.55) await this.upgrade();
      else if (r < 0.75) await this.raid();
      else if (r < 0.82) await this.reconnect(url);
      else this.watchAround();
      await sleep(rand(2000, 5000));
    }
  }
}

// ---- run ------------------------------------------------------------------------------------------

async function main() {
  const server = EXTERNAL ? null : await startServer();
  const url = EXTERNAL || server!.url;
  console.log(`Load test: ${CLIENTS} players + ${SPECTATORS} spectators for ${SECONDS} s against ${url}${server ? ' (throwaway server)' : ''}`);

  const bots = Array.from({ length: CLIENTS }, (_, i) => new Bot(i + 1));
  // Everyone arrives within ~5 s, like a room of people opening the link.
  await Promise.all(bots.map(async (b) => {
    await sleep(rand(0, 5000));
    await b.connect(url);
  }));
  const connected = bots.filter((b) => b.id >= 0).length;
  console.log(`  ${connected}/${CLIENTS} logged in`);

  const spectators: Socket[] = [];
  for (let i = 0; i < SPECTATORS; i++) {
    const s = io(url, { auth: { spectator: true }, transports: ['websocket'], forceNew: true });
    s.onAny((ev: string, data: unknown) => {
      received++;
      if (ev === 'snap' && data && typeof (data as ArrayBuffer).byteLength === 'number') snapBytes += (data as ArrayBuffer).byteLength;
    });
    spectators.push(s);
  }
  const specTimer = setInterval(() => {
    const raided = [...bases.values()].filter((b) => b.raid).map((b) => b.p);
    for (const s of spectators) s.emit('watch', { plots: raided.slice(0, 1) });
  }, 3000);

  const pollHealth = setInterval(async () => {
    try {
      health.push((await (await fetch(`${url}/api/health`)).json()) as Record<string, number>);
    } catch {
      note('health check failed');
    }
  }, 5000);

  // Drop crates during the run (throwaway server only: it knows the admin passphrase).
  const crateTimer = server
    ? setInterval(() => void fetch(`${url}/api/admin/crate`, { method: 'POST', headers: { 'x-admin-pass': ADMIN_PASS, 'content-type': 'application/json' }, body: '{}' }), 15_000)
    : null;

  const t0 = Date.now();
  const until = t0 + SECONDS * 1000;
  const progress = setInterval(() => process.stdout.write(`  ${Math.round((Date.now() - t0) / 1000)} s · raids ${raidsStarted} · deploys ${deploys} · messages ${received}\r`), 1000);
  await Promise.all(bots.map((b) => b.run(url, until)));
  clearInterval(progress);
  for (const b of bots) b.stopped = true;
  clearInterval(specTimer);
  clearInterval(pollHealth);
  if (crateTimer) clearInterval(crateTimer);
  const last = await fetch(`${url}/api/health`).then((r) => r.json() as Promise<Record<string, number>>).catch(() => null);
  if (last) health.push(last);
  for (const b of bots) b.socket.close();
  for (const s of spectators) s.close();

  // ---- report ----
  const secs = (Date.now() - t0) / 1000;
  const worst = (k: string) => Math.max(0, ...health.map((h) => Number(h[k] ?? 0)));
  const row = (name: string, xs: number[]) => console.log(`  ${name.padEnd(12)} n=${String(xs.length).padEnd(5)} p50 ${String(pct(xs, 50)).padStart(4)} ms   p95 ${String(pct(xs, 95)).padStart(4)} ms   max ${String(pct(xs, 100)).padStart(5)} ms`);
  console.log('\n\nResults');
  row('login', lat.login!);
  row('upgrade/atk', lat.act!);
  row('deploy', lat.deploy!);
  row('answer', lat.answer!);
  row('reconnect', lat.reconnect!);
  console.log(`  raids ${raidsStarted}, raiders deployed ${deploys}, messages received ${received} (${Math.round(received / secs)}/s across all screens)`);
  console.log(`  combat snapshots: ${Math.round(snapBytes / secs / 1024)} KB/s across all screens (${(snapBytes / secs / 1024 / (CLIENTS + SPECTATORS)).toFixed(1)} KB/s per screen)`);
  console.log(`  server: tick avg ${worst('tickAvgMs')} ms (worst 10 s window), tick max ${worst('tickMaxMs')} ms, loop lag max ${worst('loopLagMaxMs')} ms, memory ${worst('memoryMb')} MB, tick errors ${worst('tickErrors')}`);
  const crates = [...crateWinners.entries()];
  console.log(`  crates won: ${crates.map(([id, w]) => `#${id} → ${w.join(', ')}`).join('; ') || 'none'}`);
  if (errors.size) {
    console.log('  unexpected:');
    for (const [msg, n] of [...errors].sort((a, b) => b[1] - a[1])) console.log(`    ${n} × ${msg}`);
  }

  const checks: [string, boolean][] = [
    [`every player logged in (${connected}/${CLIENTS})`, connected === CLIENTS],
    [`actions answered fast (p95 ${pct(lat.act!, 95)} ms < 250 ms)`, pct(lat.act!, 95) < 250],
    [`deploys answered fast (p95 ${pct(lat.deploy!, 95)} ms < 250 ms)`, pct(lat.deploy!, 95) < 250],
    [`game ticks fit their 50 ms budget (max ${worst('tickMaxMs')} ms)`, worst('tickMaxMs') < 50],
    [`no tick errors (${worst('tickErrors')})`, worst('tickErrors') === 0],
    ['every crate had at most one winner', crates.every(([, w]) => w.length === 1)],
    [`no unexpected errors (${[...errors.values()].reduce((a, b) => a + b, 0)})`, errors.size === 0],
  ];
  console.log('\nChecks');
  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);

  if (server) {
    server.child.kill();
    await sleep(500);
    rmSync(server.dir, { recursive: true, force: true });
  }
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
