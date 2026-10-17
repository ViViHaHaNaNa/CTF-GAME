// Layout audit: screenshots every screen and state at five sizes and measures what overlaps.
//
//   npm run ui-audit                (writes layout-audit/latest; --out <folder> for another)
//
// Starts a throwaway game server and the dev client on spare ports (a scratch database seeded with
// worst-case players: a 20-character name, coins in the millions, every boost, Main Tower 8), then
// drives headless Chrome (playwright-core with the installed Chrome; nothing is downloaded) through:
// the map + HUD, several banners at once, the upgrade card, the objectives checklist, the pause state,
// the crate, Ranks, Live, the raid screens (picking, deploying, the result), the menu, the Live Arena
// (normal and projector) and the admin page. For each it saves a PNG and checks: UI boxes that overlap
// each other, boxes cut off by the viewport, horizontal page scroll, text under 12px, touch targets
// under 44px, and anything covering the player's own base or the minimap. Report: <out>/report.md.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { SLOTS, getWorld, inDeployZone, newDirector, type BaseState, type DirectorState } from '@siege/shared';
import { SqliteStore, type PlayerRecord } from '../src/store.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : def;
};
const ROOT = resolve(import.meta.dirname, '../..');
const OUT = resolve(ROOT, opt('out', 'layout-audit/latest'));
const ONLY = opt('only', '');
/** The client to audit (default this repo's; a worktree of an older commit for a "before" run). */
const CLIENT_DIR = resolve(ROOT, opt('client', 'client'));
const SERVER_PORT = 3993;
const CLIENT_PORT = 5182;
const PASS = 'audit-pass';
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const SIZES = [
  { name: '1920x1080', width: 1920, height: 1080, mobile: false },
  { name: '1366x768', width: 1366, height: 768, mobile: false },
  { name: '1280x720', width: 1280, height: 720, mobile: false },
  { name: 'phone-portrait-390x844', width: 390, height: 844, mobile: true },
  { name: 'phone-landscape-844x390', width: 844, height: 390, mobile: true },
].filter((s) => !ONLY || s.name.includes(ONLY));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- seed ------------------------------------------------------------------------------------------

const world = getWorld();
const plots = [...world.plots].sort((a, b) => a.order - b.order).map((p) => p.id);
const now = Date.now();
const fullBase = (hq: number): BaseState => ({ hq, walls: hq, cmd: 2, cmdLv: 3, posts: SLOTS.map((_, i) => (i < 8 ? { type: i % 3 === 2 ? 'shotgun' : 'gun', level: hq } : null)) });

function record(n: number, name: string, roll: string, extra: Partial<PlayerRecord>): Omit<PlayerRecord, 'id'> {
  return {
    roll,
    name,
    token: `audit-${roll}`,
    coins: 500,
    trophies: 100,
    plot: plots[n]!,
    base: fullBase(3),
    shieldUntil: 0,
    immuneUntil: 0,
    boosts: {},
    bank: 0,
    offline: { waves: 0, breaches: 0, coinsEarned: 0, coinsLost: 0, capped: false, raids: 0, raidLosses: 0 },
    waveNo: 0,
    siege: { ...newDirector(), surges: 40, held: 30, ramp: 30 } as DirectorState,
    mode: 'pve',
    createdAt: now,
    lastSeen: now,
    ...extra,
  };
}

function seed(file: string) {
  const store = new SqliteStore(file);
  SIZES.forEach((_, i) => {
    const k = i * 4;
    // The worst case: the longest name, millions of coins, every boost, immunity, everything unlocked.
    store.savePlayer(record(k, 'Maximilian Alexander'.slice(0, 20), `WIDE000${i}`, {
      coins: 2_345_678,
      trophies: 1_234_567,
      base: fullBase(8),
      immuneUntil: now + 3_600_000,
      boosts: { attack: { pct: 0.5, uses: 3 }, defence: { pct: 0.25, until: now + 3_600_000 }, loot: { pct: 0.75, uses: 2 } },
    }));
    // A new player still building the basic base (the objectives checklist shows).
    store.savePlayer(record(k + 1, 'Newcomer Nine', `NEW0000${i}`, { base: { hq: 1, walls: 1, cmd: 0, posts: SLOTS.map((_, j) => (j === 0 ? { type: 'pistol', level: 1 } : null)) }, siege: { ...newDirector(), surges: 1 } }));
    store.savePlayer(record(k + 2, 'Raiding Rhea Longname', `RAID000${i}`, { coins: 90_000, base: fullBase(5), mode: 'pvp' }));
    store.savePlayer(record(k + 3, 'Target Tom', `TARG000${i}`, { coins: 4000, base: fullBase(3) }));
  });
  store.close();
}

// ---- servers ---------------------------------------------------------------------------------------

function start(cmd: string, argv: string[], cwd: string, env: Record<string, string>, ready: RegExp): Promise<ChildProcess> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => fail(new Error(`${cmd} ${argv.join(' ')} did not start`)), 60_000);
    const look = (d: Buffer) => {
      if (ready.test(d.toString())) {
        clearTimeout(t);
        ok(child);
      }
    };
    child.stdout!.on('data', look);
    child.stderr!.on('data', look);
    child.on('exit', (code) => fail(new Error(`${cmd} exited (${code})`)));
  });
}

// ---- measuring -------------------------------------------------------------------------------------

/** Runs in the page: every visible UI box, then overlaps, clipping, small text, small targets, scroll. */
function measure(opts: { base: boolean }) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const name = (el: Element) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : '';
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  };
  // Separate widgets that must never sit on top of each other.
  const WIDGETS = [
    '.hud-who', '.hud-stat', '#sound-btn', '#menu-btn', '#hud-chips',
    '#wave-banner', '#mode-toggle', '#mode-cd', '#pause-btn',
    '#minimap', '#map-tools .tool', '.zoom-tools .tool', '#feed > div', '#coach', '#objectives',
    '#combo', '#threat', '#early-btn', '#ammo', '.powers > button',
    '#attack-bar', '#panel', '#toasts > .toast', '.credit', '#menu',
    // Live Arena
    '.arena-head', '.arena-title', '.arena-actions .tool', '.scoreboard', '.arena-result', '.cycle', '.arena-side',
    // admin
    '.admin-head h1', '.admin-head .tool', '.admin-sync', '.card',
  ];
  const boxes: { el: Element; n: string; r: DOMRect }[] = [];
  for (const sel of WIDGETS) for (const el of document.querySelectorAll(sel)) if (visible(el)) boxes.push({ el, n: name(el), r: el.getBoundingClientRect() });
  // Modal layers cover everything on purpose (they're dismissed with a tap).
  const modal = [...document.querySelectorAll('#unlock, #menu, .connecting, .title, .login')].find((m) => visible(m));
  const issues: string[] = [];
  const area = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ov = area(a.r, b.r);
      if (ov > 4) issues.push(`OVERLAP ${a.n}  x  ${b.n} (${Math.round(ov)} px²)`);
    }
  // A page that scrolls vertically (admin) may run past the bottom: only sideways counts there.
  const scrolls = document.documentElement.scrollHeight > H + 1;
  for (const b of boxes) {
    if (b.r.left < -1 || b.r.right > W + 1 || (!scrolls && (b.r.top < -1 || b.r.bottom > H + 1))) issues.push(`CLIPPED by the viewport: ${b.n} [${Math.round(b.r.left)},${Math.round(b.r.top)} ${Math.round(b.r.width)}x${Math.round(b.r.height)}]`);
  }
  if (document.documentElement.scrollWidth > W + 1) issues.push(`HORIZONTAL SCROLL: page is ${document.documentElement.scrollWidth}px wide in a ${W}px window`);
  // Text under 12px (every visible element that has its own text).
  const small = new Set<string>();
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('.title, svg, canvas')) continue;
    const own = [...el.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim());
    if (!own) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 11.99) small.add(`${name(el)} ${fs.toFixed(1)}px`);
  }
  for (const s of small) issues.push(`TEXT UNDER 12PX: ${s}`);
  // Touch targets under 44px.
  for (const el of document.querySelectorAll('button, a[href], input, [role="button"]')) {
    if (!visible(el) || el.closest('.title, .sr-only')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5) issues.push(`SMALL TARGET: ${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  // The player's own base (centred at the default zoom) must not be under any widget.
  const siege = (window as unknown as { siege?: { view: { toScreen(x: number, y: number): [number, number]; myPlot: number; dpr: number; canvas: HTMLCanvasElement } } }).siege;
  let baseRect: number[] | null = null;
  if (opts.base && siege && siege.view.myPlot >= 0) {
    const v = siege.view;
    const p = (window as unknown as { __plots: { x: number; y: number }[] }).__plots[v.myPlot]!;
    const c = v.canvas.getBoundingClientRect();
    const [x0, y0] = v.toScreen(p.x * 16, p.y * 16);
    const [x1, y1] = v.toScreen((p.x + 14) * 16, (p.y + 14) * 16);
    const r = new DOMRect(c.left + x0 / v.dpr, c.top + y0 / v.dpr, (x1 - x0) / v.dpr, (y1 - y0) / v.dpr);
    baseRect = [r.left, r.top, r.width, r.height].map(Math.round);
    for (const b of boxes) {
      if (b.el.closest('#panel, #hud, #banner-row, .credit, #toasts, #menu')) continue;
      const ov = area(b.r, r);
      if (ov > 4) issues.push(`COVERS OWN BASE: ${b.n} (${Math.round(ov)} px²)`);
    }
  }
  return { issues: modal ? issues.filter((i) => !i.startsWith('OVERLAP')) : issues, baseRect };
}

// ---- driving the game ------------------------------------------------------------------------------

interface Shot {
  size: string;
  state: string;
  issues: string[];
}
const results: Shot[] = [];

async function snap(page: Page, size: string, state: string, base = false) {
  await sleep(300);
  // A hidden page doesn't animate: draw a frame by hand so the canvas and HUD are current.
  await page.evaluate(() => (window as unknown as { siege?: { frame(t: number): void } }).siege?.frame(performance.now())).catch(() => {});
  const file = join(OUT, `${size}__${state}.png`);
  await page.screenshot({ path: file });
  const m = await page.evaluate(measure, { base });
  results.push({ size, state, issues: m.issues });
  process.stdout.write(`  ${size} ${state}: ${m.issues.length} issue(s)\n`);
}

const url = `http://127.0.0.1:${CLIENT_PORT}`;

async function login(page: Page, token: string, name: string) {
  // Set the token from a plain file on the same origin: a game page still running would save its own token back.
  await page.goto(`${url}/src/site.css`);
  await page.evaluate((t) => localStorage.setItem('siege.token', t), token);
  await page.goto(`${url}/siege/`);
  await page.waitForFunction(() => {
    const s = (window as unknown as { siege?: { view: { myPlot: number } } }).siege;
    return !!s && s.view.myPlot >= 0 && document.getElementById('connecting')?.hidden;
  }, null, { timeout: 30_000 });
  await page.waitForFunction((n) => document.getElementById('hud-name')?.textContent === n, name, { timeout: 10_000 }).catch(() => {
    throw new Error(`Logged in as "${name}"? The top bar says something else`);
  });
  await page.evaluate((ps) => ((window as unknown as { __plots: unknown }).__plots = ps), world.plots.map((p) => ({ x: p.x, y: p.y })));
  // Keep the canvas and HUD drawing even though the headless page has no animation frames.
  await page.evaluate(() => {
    const w = window as unknown as { siege: { frame(t: number): void }; __ticker?: number };
    w.__ticker ??= window.setInterval(() => w.siege.frame(performance.now()), 100);
  });
}

const ui = (page: Page, fn: string, ...a: unknown[]) =>
  page.evaluate(([f, xs]) => ((window as unknown as { siege: { ui: Record<string, (...v: unknown[]) => unknown> } }).siege.ui[f as string]!(...(xs as unknown[]))), [fn, a] as const);

async function centreOnBase(page: Page) {
  // What "My base" does: frame the base in the free zone (it stays framed as the HUD zones change).
  await page.evaluate(() => {
    const v = (window as unknown as { siege: { view: { frame?(p: number): void; centerOnPlot(p: number, k: number): void; baseZoom(): number; myPlot: number } } }).siege.view;
    // An older client (a "before" run) has no frame(): centre at base zoom, as its "My base" did.
    if (v.frame) v.frame(v.myPlot);
    else v.centerOnPlot(v.myPlot, v.baseZoom());
  });
  await sleep(600);
}

/** A browser context at a size. tsx compiles functions with a `__name` helper the page doesn't have: stub it. */
async function context(browser: Browser, size: (typeof SIZES)[number]) {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.mobile ? 2 : 1, isMobile: size.mobile, hasTouch: size.mobile });
  await ctx.addInitScript({ content: 'window.__name = (f) => f;' });
  return ctx;
}

async function gameStates(browser: Browser, size: (typeof SIZES)[number], i: number) {
  const ctx = await context(browser, size);
  const page = await ctx.newPage();
  const S = size.name;

  // The worst-case player.
  await login(page, `audit-WIDE000${i}`, 'Maximilian Alexander');
  await ui(page, 'openPanel', 'none');
  await centreOnBase(page);
  // Let the first surge arrive (the ammo bar, threat meter and banner show).
  await page.waitForFunction(() => !document.getElementById('cmd-bar')?.hidden, null, { timeout: 30_000 }).catch(() => {});
  await sleep(2500);
  await snap(page, S, '01-map-hud', true);

  // Several banners at once: a flash in the wave banner, three toasts, three feed lines, the coach.
  await ui(page, 'flash', '☠ HORDE! A much bigger surge is here! Hold the line, upgrade now!', 'alarm');
  for (const t of ['Maximilian Alexander is raiding your base!', 'Surges paused. Upgrade, buy and shoot freely; no zombie income while paused.', 'Crate claimed by Raiding Rhea Longname: +25% attack for 3 raids']) await ui(page, 'toast', t, 'bad', 60_000);
  for (const t of ['Raiding Rhea Longname raided Target Tom: ★★★ 100%', 'Newcomer Nine joined the siege', 'Maximilian Alexander is #1 on the leaderboard']) await ui(page, 'feed', t, 'raid');
  await ui(page, 'coach', 2);
  await sleep(400);
  await snap(page, S, '02-banners-at-once');
  await page.reload();
  await login(page, `audit-WIDE000${i}`, 'Maximilian Alexander');
  await centreOnBase(page);

  // The upgrade card (Main Tower: weapons, powers, squad picker).
  await ui(page, 'openHq');
  await sleep(500);
  await snap(page, S, '03-upgrade-panel');
  await ui(page, 'openPanel', 'mine', -1);
  await ui(page, 'openPanel', 'none');

  // The unlock popup.
  await ui(page, 'showUnlocked', 8);
  await sleep(600);
  await snap(page, S, '04-unlock-popup');
  await page.click('#unlock').catch(() => {});

  // Paused.
  await page.keyboard.press('p');
  await page.waitForFunction(() => document.getElementById('pause-btn')?.dataset.state, null, { timeout: 15_000 }).catch(() => {});
  await sleep(1500);
  await snap(page, S, '05-paused', true);
  await page.keyboard.press('p');

  // The crate (dropped from the admin API).
  await fetch(`http://127.0.0.1:${SERVER_PORT}/api/admin/crate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-pass': PASS }, body: JSON.stringify({ rarity: 'legendary' }) }).catch(() => {});
  await sleep(800);
  await ui(page, 'openPanel', 'crate');
  await sleep(500);
  await snap(page, S, '06-crate');

  await ui(page, 'openPanel', 'ranks');
  await sleep(500);
  await snap(page, S, '07-ranks');
  await ui(page, 'openPanel', 'live');
  await sleep(500);
  await snap(page, S, '08-live-list');
  await ui(page, 'openPanel', 'none');

  await page.click('#menu-btn').catch(() => {});
  await sleep(300);
  await snap(page, S, '09-menu');
  await page.click('#close-menu').catch(() => {});

  // A new player: the objectives checklist (guidance).
  await login(page, `audit-NEW0000${i}`, 'Newcomer Nine');
  await centreOnBase(page);
  await sleep(1500);
  await snap(page, S, '10-objectives', true);

  // Raiding: pick the target's card, attack, deploy, then end it for the result.
  await login(page, `audit-RAID000${i}`, 'Raiding Rhea Longname');
  const target = plots[i * 4 + 3]!;
  await page.evaluate((p) => (window as unknown as { siege: { view: { centerOnPlot(p: number, k: number): void; baseZoom(): number } } }).siege.view.centerOnPlot(p, (window as unknown as { siege: { view: { baseZoom(): number } } }).siege.view.baseZoom()), target);
  await ui(page, 'openPanel', 'other', target);
  await sleep(500);
  await snap(page, S, '11-target-card');
  await page.click('button[data-attack]').catch(() => {});
  await page.waitForFunction(() => !document.getElementById('attack-bar')?.hidden, null, { timeout: 15_000 }).catch(() => {});
  await sleep(800);
  await snap(page, S, '12-raid-army-picker');
  const tp = world.plots[target]!;
  const spots: [number, number][] = [];
  for (let y = 0; y < 14; y++) for (let x = 0; x < 14; x++) if (inDeployZone(x, y)) spots.push([tp.x + x + 0.5, tp.y + y + 0.5]);
  for (let k = 0; k < 8; k++) {
    const [wx, wy] = spots[(k * 7) % spots.length]!;
    await page.evaluate(([x, y]) => {
      const s = (window as unknown as { siege: { view: { toScreen(a: number, b: number): [number, number]; dpr: number; canvas: HTMLCanvasElement }; tap(a: number, b: number): Promise<void> } }).siege;
      const [sx, sy] = s.view.toScreen(x * 16, y * 16);
      return s.tap(sx / s.view.dpr, sy / s.view.dpr);
    }, [wx, wy] as const);
    await sleep(150);
  }
  await sleep(1500);
  await snap(page, S, '13-raid-deploying');
  await page.click('#retreat-btn').catch(() => {});
  await sleep(1500);
  await snap(page, S, '14-raid-result');
  await ctx.close();
}

async function otherPages(browser: Browser, size: (typeof SIZES)[number]) {
  const ctx = await context(browser, size);
  const page = await ctx.newPage();
  for (const [state, path] of [['20-arena', '/siege/arena/'], ['21-arena-projector', '/siege/arena/?projector=1']] as const) {
    await page.goto(`${url}${path}`);
    await page.waitForFunction(() => document.getElementById('connecting')?.hidden, null, { timeout: 20_000 }).catch(() => {});
    await sleep(2000);
    await snap(page, size.name, state);
  }
  await page.goto(`${url}/siege/admin/`);
  await page.fill('#pass', PASS);
  await page.click('#login-go');
  await page.waitForFunction(() => !document.getElementById('main')?.hidden, null, { timeout: 15_000 }).catch(() => {});
  await sleep(1000);
  await snap(page, size.name, '22-admin');
  await ctx.close();
}

/** Windows: stop the process listening on a port (only the audit's own spare ports are passed here). */
function killPort(port: number): Promise<void> {
  return new Promise((done) => {
    const ns = spawn('netstat', ['-ano'], { shell: true });
    let out = '';
    ns.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    ns.on('exit', async () => {
      const pids = new Set(out.split('\n').filter((l) => l.includes(`:${port} `) && l.includes('LISTEN')).map((l) => l.trim().split(/\s+/).at(-1)!));
      for (const pid of pids) await new Promise((r) => spawn('taskkill', ['/pid', pid, '/F'], { shell: true }).on('exit', r));
      done();
    });
  });
}

// ---- run -------------------------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'siege-ui-audit-'));
  const db = join(dir, 'audit.db');
  seed(db);
  const env = { SIEGE_PORT: String(SERVER_PORT), SIEGE_DB: db, SIEGE_BACKUPS: join(dir, 'backups'), SIEGE_ADMIN_PASS: PASS, SIEGE_HOST: '127.0.0.1', DEV_MODE: 'false' };
  console.log(`UI audit → ${OUT}`);
  const server = await start('npx', ['tsx', 'src/index.ts'], join(ROOT, 'server'), env, /game server on port/);
  const client = await start('npx', ['vite', '--port', String(CLIENT_PORT), '--strictPort', '--host', '127.0.0.1'], CLIENT_DIR, env, /ready in|Local:/);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  try {
    for (const [i, size] of SIZES.entries()) {
      console.log(size.name);
      await gameStates(browser, size, i);
      await otherPages(browser, size);
    }
  } catch (e) {
    console.error('Audit failed:', e);
  } finally {
    await browser.close();
    server.kill();
    client.kill();
    // Windows: shell-spawned trees need a firmer kill.
    if (process.platform === 'win32') {
      for (const c of [server, client]) await new Promise((r) => spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { shell: true }).on('exit', r));
      // npx can leave the real node process behind: stop whatever still listens on the audit's ports.
      for (const port of [SERVER_PORT, CLIENT_PORT]) await killPort(port);
    }
    await sleep(1500);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the server may still hold the scratch database for a moment: it's in the temp folder anyway */
    }
  }

  // Report: per state and size, then a deduplicated list of everything found.
  const lines = [`# Layout audit (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`, '', `${results.length} screenshots, ${results.reduce((a, r) => a + r.issues.length, 0)} issues.`, ''];
  lines.push('| State | ' + SIZES.map((s) => s.name).join(' | ') + ' |', '|---|' + SIZES.map(() => '---').join('|') + '|');
  for (const state of [...new Set(results.map((r) => r.state))]) lines.push(`| ${state} | ` + SIZES.map((s) => String(results.find((r) => r.state === state && r.size === s.name)?.issues.length ?? '-')).join(' | ') + ' |');
  lines.push('', '## Issues by screenshot', '');
  for (const r of results) {
    if (!r.issues.length) continue;
    lines.push(`### ${r.size} · ${r.state}`, ...r.issues.map((i) => `- ${i}`), '');
  }
  writeFileSync(join(OUT, 'report.md'), lines.join('\n'));
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 1));
  console.log(`\n${results.reduce((a, r) => a + r.issues.length, 0)} issues in ${results.length} screenshots → ${join(OUT, 'report.md')}`);
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
