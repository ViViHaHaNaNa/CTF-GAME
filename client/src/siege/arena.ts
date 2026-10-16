import { type BaseSummary, type CrateView, type FeedItem, type RaidResult } from '@siege/shared';
import { spectatorSocket } from './net.ts';
import { loadSprites } from './sprites.ts';
import { bindLiveStream } from './stream.ts';
import { WorldView } from './world.ts';

// Live Arena: read-only spectating for any device, no login. Shows the battle being watched with a
// scoreboard, the list of live battles, leaderboard, crate and feed. Projector mode (?projector)
// cycles through live battles on its own and shows a big leaderboard when nothing is happening.

/** How long the projector stays on one battle when several are live. */
const CYCLE_MS = 20_000;
/** How long a finished battle's result stays up. */
const RESULT_MS = 6_000;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let view: WorldView;
let skew = 0;
let projector = new URLSearchParams(location.search).has('projector');
/** Plot of the battle on screen (-1 = none). */
let current = -1;
let switchedAt = 0;
let resultUntil = 0;
let crate: CrateView | null = null;
let feed: FeedItem[] = [];
let watchKey = '';
const rendered = new Map<string, string>();

const serverNow = () => Date.now() + skew;

async function boot() {
  try {
    view = new WorldView($<HTMLCanvasElement>('board'), await loadSprites((d, t) => ($('connecting').textContent = `Loading art ${Math.round((100 * d) / t)}%`)));
    view.prebake();
  } catch (e) {
    $('connecting').textContent = `Could not load the art: ${(e as Error).message}`;
    return;
  }
  $('connecting').textContent = 'Connecting...';
  const wrap = $('board-wrap');
  new ResizeObserver(() => view.fit(wrap.clientWidth, wrap.clientHeight)).observe(wrap);
  view.fit(wrap.clientWidth, wrap.clientHeight);
  setProjector(projector);

  const socket = spectatorSocket();
  bindLiveStream(socket, view);
  socket.on('connect', () => {
    $('connecting').hidden = true;
    watchKey = '';
  });
  socket.on('disconnect', () => {
    $('connecting').textContent = 'Connection lost. Reconnecting...';
    $('connecting').hidden = false;
  });
  socket.on('connect_error', () => {
    $('connecting').textContent = 'Cannot reach the game server. Retrying...';
    $('connecting').hidden = false;
  });
  socket.on('world', (m: { bases: BaseSummary[]; now: number; full?: boolean }) => {
    skew = m.now - Date.now();
    view.clockSkew = skew;
    if (m.full) view.bases.clear();
    for (const b of m.bases) view.bases.set(b.p, b);
    tick();
  });
  socket.on('arena', (m: { feed: FeedItem[]; crate: CrateView | null }) => {
    feed = m.feed.slice(-12);
    setCrate(m.crate);
  });
  socket.on('crate', (c: CrateView | null) => setCrate(c));
  socket.on('status', (st: { paused: boolean; frozen: boolean }) => {
    const el = $('org-status');
    el.hidden = !st.paused && !st.frozen;
    el.textContent = st.paused ? '⏸ Paused' : 'Leaderboard frozen';
  });
  socket.on('feed', (f: FeedItem) => {
    feed.push(f);
    if (feed.length > 12) feed.shift();
    renderSide();
  });
  socket.on('raidEnd', (r: RaidResult) => {
    if (r.plot !== current) return;
    showResult(r);
  });

  $('battles').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-plot]');
    if (b) focus(Number(b.dataset.plot));
  });
  $('projector-btn').addEventListener('click', () => setProjector(!projector));
  $('fullscreen-btn').addEventListener('click', () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  });

  // Watch the battle on screen (and nothing else: the arena keeps server load tiny).
  setInterval(() => {
    const want = current >= 0 ? [current] : [];
    const key = want.join(',');
    if (key === watchKey || !socket.connected) return;
    watchKey = key;
    socket.emit('watch', { plots: want });
    for (const plot of [...view.live.keys()]) if (!want.includes(plot)) view.live.delete(plot);
  }, 300);
  setInterval(tick, 500);
  requestAnimationFrame(frame);
}

function setProjector(on: boolean) {
  projector = on;
  document.body.classList.toggle('projector', on);
  $('projector-btn').classList.toggle('on', on);
  const url = new URL(location.href);
  if (on) url.searchParams.set('projector', '1');
  else url.searchParams.delete('projector');
  history.replaceState(null, '', url);
  switchedAt = performance.now();
}

function liveBattles(): BaseSummary[] {
  return [...view.bases.values()].filter((b) => b.raid).sort((a, b) => a.raid - b.raid);
}

function focus(plot: number) {
  current = plot;
  switchedAt = performance.now();
  resultUntil = 0;
  $('result').hidden = true;
  view.centerOnPlot(plot, view.baseZoom());
  tick();
}

/** Pick what's on screen: keep the current battle, move on when it ends, cycle in projector mode. */
function tick() {
  if (!view) return;
  const now = performance.now();
  const list = liveBattles();
  if (now >= resultUntil) {
    $('result').hidden = true;
    const i = list.findIndex((b) => b.p === current);
    if (i < 0) {
      current = -1;
      if (list.length) focus(list[0]!.p);
    } else if (projector && list.length > 1 && now - switchedAt > CYCLE_MS) {
      focus(list[(i + 1) % list.length]!.p);
    }
  }
  const idle = current < 0;
  $('idle').hidden = !idle;
  $('scoreboard').hidden = idle;
  const cycle = $('cycle');
  const i = list.findIndex((b) => b.p === current);
  cycle.hidden = !(projector && list.length > 1 && i >= 0 && now >= resultUntil);
  if (!cycle.hidden) cycle.textContent = `Battle ${i + 1} of ${list.length} · next in ${Math.max(0, Math.ceil((CYCLE_MS - (now - switchedAt)) / 1000))}s`;
  renderScoreboard();
  renderSide();
}

function frame(now: number) {
  if (current < 0) {
    // Nothing to watch: drift slowly over the wasteland.
    const W = 180 * 16;
    view.jumpTo(W / 2 + Math.sin(now / 45_000) * W * 0.3, W / 2 + Math.cos(now / 61_000) * W * 0.3, Math.max(1, view.baseZoom() - 1));
  }
  view.update(now);
  view.draw(now);
  requestAnimationFrame(frame);
}

function clock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Set innerHTML only when it changed. */
function put(id: string, html: string) {
  if (rendered.get(id) === html) return;
  rendered.set(id, html);
  $(id).innerHTML = html;
}

function renderScoreboard() {
  // While a result is up, the scoreboard keeps the battle's final numbers.
  if (current < 0 || performance.now() < resultUntil) return;
  const s = view.bases.get(current);
  const r = view.live.get(current)?.raid ?? null;
  $('sb-att').textContent = r?.attacker ?? s?.raider ?? '';
  $('sb-def').textContent = r?.defender ?? s?.name ?? '';
  const dmg = r?.destruction ?? 0;
  $('sb-dmg').textContent = `${dmg}%`;
  $('sb-fill').style.width = `${Math.min(100, dmg)}%`;
  $('sb-fill').classList.toggle('win', dmg >= 50);
  $('sb-time').textContent = r ? clock(r.left * 1000) : '-';
  $('sb-troops').textContent = String(r?.deployed ?? 0);
}

function showResult(r: RaidResult) {
  resultUntil = performance.now() + RESULT_MS;
  $('sb-att').textContent = r.attacker;
  $('sb-def').textContent = r.defender;
  $('sb-dmg').textContent = `${r.destruction}%`;
  $('sb-fill').style.width = `${Math.min(100, r.destruction)}%`;
  $('sb-fill').classList.toggle('win', r.won);
  $('sb-time').textContent = 'over';
  const el = $('result');
  el.className = `arena-result ${r.won ? 'won' : 'held'}`;
  const detail = r.won ? `${r.destruction}% destroyed · +${r.loot} coins · +${r.trophies} trophies` : `${r.destruction}% destroyed · ${r.attacker} loses ${Math.abs(r.trophies)} trophies`;
  el.innerHTML = `<b>${esc(r.won ? `${r.attacker} wins!` : `${r.defender} holds!`)}</b><span>${esc(detail)}</span>`;
  el.hidden = false;
}

function setCrate(c: CrateView | null) {
  crate = c;
  view.crate = c && !c.claimedBy ? { rarity: c.rarity } : null;
  renderSide();
}

function renderSide() {
  const list = liveBattles();
  put(
    'battles',
    list.length
      ? list.map((b) => `<li><button data-plot="${b.p}" class="${b.p === current ? 'me' : ''}"><span class="nm">${esc(b.raider ?? '?')} ⚔ ${esc(b.name)}</span><span class="val">${b.p === current ? 'watching' : 'watch'}</span></button></li>`).join('')
      : '<li class="empty">No raids right now.</li>',
  );
  const ranked = [...view.bases.values()].sort((a, b) => b.trophies - a.trophies || a.id - b.id);
  const row = (b: BaseSummary, i: number) => `<li><span class="rank">#${i + 1}</span><span class="nm">${esc(b.name)} <small>Lv${b.hq}</small></span><span class="val">♛ ${b.trophies}</span></li>`;
  put('ranks', ranked.slice(0, 10).map(row).join('') || '<li class="empty">No players yet.</li>');
  put('big-ranks', ranked.slice(0, projector ? 10 : 5).map(row).join(''));
  put('feed-list', [...feed].reverse().slice(0, 8).map((f) => `<li class="${f.kind}">${esc(f.text)}</li>`).join('') || '<li class="empty">Nothing yet.</li>');
  let box = '<p class="empty">The next crate drops soon.</p>';
  if (crate && crate.claimedBy) box = `<p><span class="rarity r-${crate.rarity}">${crate.rarity}</span> cracked by <b>${esc(crate.claimedBy)}</b>: ${esc(crate.reward ?? '')}</p><p class="empty">Answer: <code>${esc(crate.answer ?? '')}</code> · next crate in <span data-until="${crate.expiresAt}"></span></p>`;
  else if (crate) box = `<p><span class="rarity r-${crate.rarity}">${crate.rarity}</span> crate is up! First correct answer in the game wins it.</p><p class="q-prompt">${esc(crate.prompt)}</p>${crate.code ? `<pre class="code" data-lang="${esc(crate.lang)}">${esc(crate.code)}</pre>` : ''}<p class="empty">Expires in <span data-until="${crate.expiresAt}"></span></p>`;
  put('crate-box', box);
  for (const el of document.querySelectorAll<HTMLElement>('[data-until]')) el.textContent = clock(Number(el.dataset.until) - serverNow());
}

void boot();
