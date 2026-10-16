import type { CrateView, FeedItem, RaidStatus } from '@siege/shared';
import { SERVER_URL } from './config.ts';

// Organiser page: pause, freeze, crates, player resets, backups and server health.
// Talks to /api/admin/* with the passphrase in a header; the passphrase lives in sessionStorage
// only (closing the tab locks the page again).

interface AdminState {
  paused: boolean;
  frozen: boolean;
  now: number;
  nextCrateAt: number;
  crate: CrateView | null;
  crateAnswers: string[];
  questions: { total: number; used: number };
  raids: RaidStatus[];
  feed: FeedItem[];
  players: { id: number; name: string; roll: string; plot: number; hq: number; coins: number; trophies: number; online: boolean; lastSeen: number }[];
  server: Record<string, number | boolean>;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const KEY = 'siege.admin';
const API = `${SERVER_URL ?? ''}/api/admin`;

let pass = '';
let state: AdminState | null = null;
let skew = 0;
const rendered = new Map<string, string>();

function getPass() {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

function setPass(p: string) {
  pass = p;
  try {
    if (p) sessionStorage.setItem(KEY, p);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* fine: just won't survive a reload */
  }
}

async function call<T>(path: string, body?: unknown): Promise<{ ok: true } & T | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(`${API}/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-admin-pass': pass, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) return { ok: false, error: data.error ?? `Server said ${res.status}`, status: res.status };
    return data as { ok: true } & T;
  } catch {
    return { ok: false, error: 'Cannot reach the game server', status: 0 };
  }
}

async function refresh() {
  if (!pass) return;
  const r = await call<AdminState>('state');
  if (!r.ok) {
    if (r.status === 401 || r.status === 429 || r.status === 503) return lock(r.error);
    $('sync').textContent = `⚠ ${r.error}`;
    return;
  }
  state = r;
  skew = r.now - Date.now();
  $('sync').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  $('login').hidden = true;
  $('main').hidden = false;
  render();
}

function lock(error = '') {
  setPass('');
  state = null;
  $('main').hidden = true;
  $('login').hidden = false;
  $('login-error').textContent = error;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function clock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function put(id: string, html: string) {
  if (rendered.get(id) === html) return;
  rendered.set(id, html);
  $(id).innerHTML = html;
}

function render() {
  const s = state;
  if (!s) return;
  const now = Date.now() + skew;
  $('game-state').textContent = s.paused ? '⏸ Paused' : '▶ Running';
  $('game-state').className = `big ${s.paused ? 'bad' : 'good'}`;
  $('pause-btn').textContent = s.paused ? 'Resume the game' : 'Pause the game';
  $('board-state').textContent = s.frozen ? '❄ Frozen' : 'Live';
  $('board-state').className = `big ${s.frozen ? 'cold' : 'good'}`;
  $('freeze-btn').textContent = s.frozen ? 'Unfreeze leaderboard' : 'Freeze leaderboard';

  const c = s.crate;
  const next = `Next drop in <b>${clock(s.nextCrateAt - now)}</b>${s.paused ? ' (paused)' : ''} · questions used ${s.questions.used}/${s.questions.total}`;
  put(
    'crate',
    c
      ? `<p><span class="rarity r-${c.rarity}">${c.rarity}</span> ${c.claimedBy ? `claimed by <b>${esc(c.claimedBy)}</b> (${esc(c.reward ?? '')})` : '<b>open</b>, nobody has it yet'}</p><p class="q">${esc(c.prompt)}</p><p class="note">Accepted: ${s.crateAnswers.map((a) => `<code>${esc(a)}</code>`).join(' ')}</p><p class="note">${next}</p>`
      : `<p class="note">No crate yet. ${next}</p>`,
  );

  const v = s.server;
  const kv: [string, string][] = [
    ['Players online', `${v.players ?? 0} (${v.spectators ?? 0} watching)`],
    ['Connections', String(v.sockets ?? 0)],
    ['Tick time', `${v.tickAvgMs ?? 0} ms avg · ${v.tickMaxMs ?? 0} ms max (budget 50)`],
    ['Loop lag', `${v.loopLagMaxMs ?? 0} ms max`],
    ['Tick errors', String(v.tickErrors ?? 0)],
    ['Memory', `${v.memoryMb ?? 0} MB`],
    ['Up for', clock(Number(v.uptimeS ?? 0) * 1000)],
  ];
  put('server', kv.map(([k, val]) => `<dt>${k}</dt><dd>${esc(val)}</dd>`).join(''));

  const q = $<HTMLInputElement>('search').value.trim().toLowerCase();
  const list = s.players.filter((p) => !q || p.name.toLowerCase().includes(q) || p.roll.toLowerCase().includes(q));
  $('player-count').textContent = `(${s.players.length}, ${s.players.filter((p) => p.online).length} online)`;
  put(
    'players',
    list
      .map(
        (p, i) =>
          `<tr><td>${i + 1}</td><td>${esc(p.name)}</td><td><code>${esc(p.roll)}</code></td><td>${p.hq}</td><td>${p.coins}</td><td>${p.trophies}</td><td>${p.online ? '<span class="dot on"></span>online' : '<span class="dot"></span>away'}</td><td class="acts"><button class="tool" data-reset="${p.id}" data-name="${esc(p.name)}">Reset</button><button class="tool danger" data-delete="${p.id}" data-name="${esc(p.name)}">Delete</button></td></tr>`,
      )
      .join('') || '<tr><td colspan="8" class="note">No players.</td></tr>',
  );
  put('raids', s.raids.map((r) => `<li><b>${esc(r.attacker)}</b> ⚔ <b>${esc(r.defender)}</b> · ${r.destruction}% · ${'★'.repeat(r.stars)}${'☆'.repeat(3 - r.stars)} · ${r.deployed} sent</li>`).join('') || '<li class="note">None right now.</li>');
  put('feed', [...s.feed].reverse().map((f) => `<li>${new Date(f.t).toLocaleTimeString()} · ${esc(f.text)}</li>`).join('') || '<li class="note">Nothing yet.</li>');
}

function toast(text: string, kind: 'good' | 'bad' | '' = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  $('toasts').append(t);
  setTimeout(() => t.remove(), 4000);
}

async function act(path: string, body: unknown, done: string) {
  const r = await call<{ file?: string }>(path, body);
  if (!r.ok) toast(r.error, 'bad');
  else toast(r.file ? `${done}: ${r.file}` : done, 'good');
  await refresh();
}

function bind() {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setPass($<HTMLInputElement>('pass').value);
    $('login-error').textContent = '';
    await refresh();
  });
  $('logout').addEventListener('click', () => lock());
  $('pause-btn').addEventListener('click', () => {
    if (!state) return;
    if (!state.paused && !confirm('Pause the game for everyone?')) return;
    void act('pause', { on: !state.paused }, state.paused ? 'Game resumed' : 'Game paused');
  });
  $('freeze-btn').addEventListener('click', () => {
    if (state) void act('freeze', { on: !state.frozen }, state.frozen ? 'Leaderboard is live' : 'Leaderboard frozen');
  });
  document.querySelectorAll<HTMLButtonElement>('[data-crate]').forEach((b) =>
    b.addEventListener('click', () => {
      const open = state?.crate && !state.crate.claimedBy;
      if (open && !confirm('The current crate is still open. Drop a new one anyway (the open one expires)?')) return;
      void act('crate', b.dataset.crate ? { rarity: b.dataset.crate } : {}, 'Crate dropped');
    }),
  );
  $('backup-btn').addEventListener('click', () => void act('backup', {}, 'Backup saved'));
  $('search').addEventListener('input', render);
  $('players').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    const name = b.dataset.name ?? '';
    if (b.dataset.reset) {
      if (confirm(`Reset ${name}? Their base, coins, trophies and boosts go back to the start. They keep their account and plot.`)) void act('reset', { id: Number(b.dataset.reset) }, `${name} reset`);
    } else if (b.dataset.delete) {
      const typed = prompt(`Delete ${name}'s account and free their plot? This can't be undone.\nType their name to confirm:`);
      if (typed !== null && typed.trim().toLowerCase() === name.toLowerCase()) void act('delete', { id: Number(b.dataset.delete) }, `${name} deleted`);
      else if (typed !== null) toast('Name did not match: nothing deleted', 'bad');
    }
  });
}

bind();
pass = getPass();
if (pass) void refresh();
setInterval(() => void refresh(), 2000);
