import {
  CONFIG,
  POST_TYPES,
  postStats,
  quote,
  slotsUnlocked,
  type BaseAction,
  type OfflineSummary,
  type PlayerView,
  type PostType,
  type Snapshot,
} from '@siege/shared';
import { Board, type Pick } from './board.ts';
import { Net, saveToken } from './net.ts';
import { loadSprites } from './sprites.ts';

// Game page controller: login, HUD, wave banner, tap-to-select and the build/upgrade panel.
// Everything shown comes from the server; buttons only send intents.

interface WaveInfo {
  phase: 'calm' | 'wave';
  nextIn?: number;
  sides?: string[];
  base?: PlayerView['base'];
  snapshot?: Snapshot;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SIDE_NAME: Record<string, string> = { n: 'north', e: 'east', s: 'south', w: 'west' };
const POST_NAME: Record<PostType, string> = { pistol: 'Pistol post', gun: 'Gun post', shotgun: 'Shotgun post' };

let player: PlayerView | null = null;
let wave: WaveInfo = { phase: 'calm' };
let calmEndsAt = 0;
let board: Board;
/** Created after the art has loaded, so no server message can arrive before we listen. */
let net: Net;

// ---- boot ---------------------------------------------------------------------------------------

async function boot() {
  try {
    board = new Board($<HTMLCanvasElement>('board'), await loadSprites());
  } catch (e) {
    $('connecting').textContent = `Could not load the art: ${(e as Error).message}`;
    return;
  }
  const wrap = $('board-wrap');
  new ResizeObserver(() => board.fit(wrap.clientWidth, wrap.clientHeight)).observe(wrap);
  board.fit(wrap.clientWidth, wrap.clientHeight);
  net = new Net();
  bindInput();
  bindNet();
  requestAnimationFrame(frame);
}

function frame(now: number) {
  board.draw(now);
  if (wave.phase === 'calm' && player) {
    const s = Math.max(0, Math.ceil((calmEndsAt - Date.now()) / 1000));
    setBanner(s > 0 ? `All quiet. Next wave in ${s}s` : 'Here they come...', false);
  }
  requestAnimationFrame(frame);
}

// ---- network ------------------------------------------------------------------------------------

function bindNet() {
  const s = net.socket;
  s.on('connect', () => $('connecting').hidden = true);
  s.on('disconnect', () => {
    $('connecting').textContent = 'Connection lost. Reconnecting...';
    $('connecting').hidden = false;
  });
  s.on('connect_error', () => {
    $('connecting').textContent = 'Cannot reach the game server. Retrying...';
    $('connecting').hidden = false;
  });
  s.on('needLogin', () => {
    player = null;
    saveToken(null);
    $('hud').hidden = true;
    $('panel').hidden = true;
    $('wave-banner').hidden = true;
    $('login').hidden = false;
    board.base = null;
  });
  s.on('welcome', (w: { token: string; player: PlayerView; offline: (OfflineSummary & { credited: number }) | null; wave: WaveInfo }) => {
    saveToken(w.token);
    $('login').hidden = true;
    $('hud').hidden = false;
    $('panel').hidden = false;
    $('wave-banner').hidden = false;
    setPlayer(w.player);
    onWave(w.wave);
    if (w.offline) {
      const o = w.offline;
      const parts = [`While you were away: ${o.waves} wave${o.waves === 1 ? '' : 's'}`];
      if (o.breaches) parts.push(`${o.breaches} breach${o.breaches === 1 ? '' : 'es'} (-${o.coinsLost} coins)`);
      parts.push(`+${o.credited} coins banked${o.capped ? ' (bank was full)' : ''}`);
      toast(parts.join(', '), o.breaches ? 'bad' : 'good', 6000);
    }
  });
  s.on('wave', onWave);
  s.on('snap', (snap: Snapshot) => board.applySnapshot(snap, performance.now()));
  s.on('coins', (c: { coins: number; delta: number }) => {
    if (!player) return;
    player.coins = c.coins;
    renderHud(c.delta);
    renderPanel();
  });
  s.on('waveEnd', (r: { breached: boolean; kills: number; coins: number; lost: number; total: number }) => {
    if (player) {
      player.coins = r.total;
      renderHud();
      renderPanel();
    }
    if (r.breached) toast(`Breach! The Main Tower fell. Lost ${r.lost} coins.`, 'bad');
    else toast(`Wave held: ${r.kills} zombies down, +${r.coins} coins`, 'good');
  });
}

function onWave(w: WaveInfo) {
  wave = w;
  if (w.phase === 'wave') {
    board.resetCombat();
    board.waveBase = w.base ?? null;
    if (w.snapshot) board.applySnapshot(w.snapshot, performance.now());
    const from = (w.sides ?? []).map((s) => SIDE_NAME[s]).join(' and ');
    setBanner(`Zombies incoming from the ${from}!`, true);
  } else {
    board.waveBase = null;
    calmEndsAt = Date.now() + (w.nextIn ?? CONFIG.waves.calm) * 1000;
  }
  renderPanel();
}

// ---- input --------------------------------------------------------------------------------------

function bindInput() {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $<HTMLButtonElement>('login-go');
    btn.disabled = true;
    $('login-error').textContent = '';
    const r = await net.login($<HTMLInputElement>('login-name').value, $<HTMLInputElement>('login-roll').value);
    btn.disabled = false;
    if (!r.ok) $('login-error').textContent = r.error;
  });

  const canvas = board.canvas;
  let downAt: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 10) return;
    const r = canvas.getBoundingClientRect();
    select(board.pick(e.clientX - r.left, e.clientY - r.top));
  });

  $('menu-btn').addEventListener('click', () => ($('menu').hidden = !$('menu').hidden));
  $('close-menu').addEventListener('click', () => ($('menu').hidden = true));
  $('logout-btn').addEventListener('click', () => {
    $('menu').hidden = true;
    saveToken(null);
    net.logout();
  });

  $('panel').addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!btn || btn.disabled) return;
    const action = JSON.parse(btn.dataset.act!) as BaseAction;
    btn.disabled = true;
    const r = await net.act(action);
    if (r.ok) {
      setPlayer(r.player);
      toast(actionDone(action), 'good', 2200);
    } else {
      toast(r.error, 'bad');
      renderPanel();
    }
  });
}

function select(p: Pick | null) {
  board.selected = p;
  renderPanel();
}

// ---- rendering ----------------------------------------------------------------------------------

function setPlayer(p: PlayerView) {
  player = p;
  board.base = p.base;
  renderHud();
  renderPanel();
}

let deltaTimer = 0;
function renderHud(delta = 0) {
  if (!player) return;
  $('hud-name').textContent = player.name;
  $('hud-hq').textContent = `Main Tower Lv ${player.base.hq} · ${player.roll}`;
  $('hud-coins').textContent = String(player.coins);
  $('hud-trophies').textContent = String(player.trophies);
  if (delta > 0) {
    const d = $('hud-delta');
    d.textContent = `+${delta}`;
    d.classList.add('show');
    clearTimeout(deltaTimer);
    deltaTimer = window.setTimeout(() => d.classList.remove('show'), 500);
  }
}

function setBanner(text: string, attack: boolean) {
  const b = $('wave-banner');
  if (b.textContent !== text) b.textContent = text;
  b.classList.toggle('attack', attack);
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function button(label: string, action: BaseAction, extra = ''): string {
  const q = quote(player!.base, action);
  const short = q.ok && player!.coins < q.cost ? `Need ${q.cost - player!.coins} more` : '';
  const disabled = !q.ok || player!.coins < q.cost;
  const sub = !q.ok ? esc(q.reason ?? '') : `${q.cost} coins${short ? ` · ${short}` : ''}`;
  return `<button class="btn" data-act='${JSON.stringify(action)}' ${disabled ? 'disabled' : ''}>${esc(label)}${extra}<small>${sub}</small></button>`;
}

function stats(items: [string, string | number][]): string {
  return `<div class="stats">${items.map(([k, v]) => `<div>${esc(k)}<b>${esc(String(v))}</b></div>`).join('')}</div>`;
}

function renderPanel() {
  const panel = $('panel');
  if (!player) return;
  const base = player.base;
  const sel = board.selected;
  const waveNote = wave.phase === 'wave' ? '<p class="note">A wave is on: changes join the fight from the next wave.</p>' : '';
  let html = '';
  if (!sel) {
    const posts = base.posts.filter(Boolean).length;
    html = `<h2>Your base</h2><p class="sub">Tap the Main Tower, a wall or a post slot to build and upgrade.</p>${stats([
      ['Main Tower', `Lv ${base.hq}`],
      ['Walls', `Lv ${base.walls}`],
      ['Posts', `${posts}/${slotsUnlocked(base.hq)}`],
    ])}<p class="note">Zombies attack every few seconds. Every kill pays coins, even while you're away (up to ${CONFIG.offline.bankCap}).</p>`;
  } else if (sel.kind === 'hq') {
    const next = base.hq + 1;
    const unlocks: string[] = [];
    if (next <= CONFIG.hq.maxLevel) {
      const moreSlots = slotsUnlocked(next) - slotsUnlocked(base.hq);
      if (moreSlots > 0) unlocks.push(`+${moreSlots} post slot`);
      for (const t of POST_TYPES) if (CONFIG.hq.postUnlock[t] === next) unlocks.push(`${POST_NAME[t]}s`);
      unlocks.push(`posts & walls up to Lv ${next}`);
    }
    html = `<h2>Main Tower · Lv ${base.hq}</h2><p class="sub">The heart of your base. If it falls, you lose some coins. Its level caps everything else.</p>${stats([
      ['Health', CONFIG.hq.hp(base.hq)],
      ['Post slots', `${slotsUnlocked(base.hq)}/8`],
      ['Next level', next <= CONFIG.hq.maxLevel ? unlocks.join(', ') : 'Max'],
    ])}<div class="actions">${button(`Upgrade to Lv ${next}`, { kind: 'hq' })}</div>${waveNote}`;
  } else if (sel.kind === 'walls') {
    const kind = base.walls >= CONFIG.walls.reinforcedFromLevel ? 'Reinforced' : 'Wooden';
    const nextKind = base.walls + 1 >= CONFIG.walls.reinforcedFromLevel ? 'reinforced' : 'wooden';
    html = `<h2>Walls · Lv ${base.walls}</h2><p class="sub">${kind} walls ring your base. Axe zombies hit them hard.</p>${stats([
      ['Health each', CONFIG.walls.hp(base.walls)],
      ['Next level', base.walls < CONFIG.walls.maxLevel ? `${CONFIG.walls.hp(base.walls + 1)} (${nextKind})` : 'Max'],
    ])}<div class="actions">${button(`Upgrade to Lv ${base.walls + 1}`, { kind: 'walls' })}</div>${waveNote}`;
  } else {
    const slot = sel.slot;
    const p = base.posts[slot];
    if (slot >= slotsUnlocked(base.hq)) {
      const need = CONFIG.hq.slotsUnlocked.findIndex((n) => n > slot) + 1;
      html = `<h2>Locked slot</h2><p class="sub">Upgrade the Main Tower to Lv ${need} to build here.</p>`;
    } else if (!p) {
      const opts = POST_TYPES.map((t) => {
        const st = postStats(t, 1);
        return button(POST_NAME[t], { kind: 'build', slot, type: t }, `<small>dmg ${st.damage} · range ${st.range} · every ${st.cooldown}s</small>`);
      }).join('');
      html = `<h2>Empty slot</h2><p class="sub">Station a survivor behind a barricade.</p><div class="actions">${opts}</div>${waveNote}`;
    } else {
      const now = postStats(p.type, p.level);
      const nx = p.level < CONFIG.posts.maxLevel ? postStats(p.type, p.level + 1) : null;
      html = `<h2>${POST_NAME[p.type]} · Lv ${p.level}</h2><p class="sub">${p.type === 'shotgun' ? 'Short range, hits a whole group.' : p.type === 'gun' ? 'Long range, hard hitting.' : 'Quick shots, decent range.'}${p.level < CONFIG.posts.helmetFromLevel ? ` Gets a helmet at Lv ${CONFIG.posts.helmetFromLevel}.` : ''}</p>${stats([
        ['Damage', nx ? `${now.damage} → ${nx.damage}` : now.damage],
        ['Health', nx ? `${now.hp} → ${nx.hp}` : now.hp],
        ['Range', now.range],
        ['Fires every', `${now.cooldown}s`],
      ])}<div class="actions">${button(`Upgrade to Lv ${p.level + 1}`, { kind: 'post', slot })}</div>${waveNote}`;
    }
  }
  if (panel.innerHTML !== html) panel.innerHTML = html;
}

function actionDone(a: BaseAction): string {
  switch (a.kind) {
    case 'hq':
      return 'Main Tower upgraded!';
    case 'walls':
      return 'Walls upgraded!';
    case 'build':
      return `${POST_NAME[a.type]} built!`;
    case 'post':
      return 'Post upgraded!';
  }
}

function toast(text: string, kind: 'good' | 'bad' | '' = '', ms = 3500) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  $('toasts').append(t);
  setTimeout(() => t.remove(), ms);
  while ($('toasts').children.length > 3) $('toasts').firstElementChild!.remove();
}

void boot();
