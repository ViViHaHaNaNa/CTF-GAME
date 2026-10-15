import {
  CONFIG,
  PLOT,
  POST_TYPES,
  RAIDER_KINDS,
  boostLabel,
  getWorld,
  liveBoosts,
  postStats,
  quote,
  raiderUnlocked,
  slotsUnlocked,
  trophyStake,
  type BaseAction,
  type BaseSummary,
  type CrateView,
  type FeedItem,
  type OfflineSummary,
  type PlayerView,
  type PostType,
  type RaidResult,
  type RaidStatus,
  type RaiderKind,
  type Snapshot,
} from '@siege/shared';
import { Net, saveToken } from './net.ts';
import { loadSprites } from './sprites.ts';
import { CRATE_SPOT, WorldView, type LiveState } from './world.ts';

// Game page controller: login, HUD, the shared map (pan / zoom / tap), base cards, raids, lists.
// Everything shown comes from the server; buttons only send intents.

interface BaseLive {
  p: number;
  phase: LiveState['phase'];
  nextIn?: number;
  snapshot?: Snapshot;
  raid?: RaidStatus;
}

type PanelMode = 'none' | 'mine' | 'other' | 'ranks' | 'live' | 'crate';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const world = getWorld();
const POST_NAME: Record<PostType, string> = { pistol: 'Pistol post', gun: 'Gun post', shotgun: 'Shotgun post' };
const RAIDER_NAME: Record<RaiderKind, string> = { r_bat: 'Bat', r_pistol: 'Pistol', r_helmet: 'Brute', r_shotgun: 'Shotgun' };
const WATCH_MAX = 6;

let player: PlayerView | null = null;
let view: WorldView;
/** Created after the art has loaded, so no server message can arrive before we listen. */
let net: Net;
let skew = 0;
let panel: PanelMode = 'none';
let selectedPlot = -1;
/** Plot the player asked to watch (spectate), kept in the area of interest while near it. */
let focusPlot = -1;
let myRaid: RaidStatus | null = null;
let troop: RaiderKind = 'r_bat';
let centred = false;
let lastRaidEnd = 0;
let watchKey = '';
let crate: CrateView | null = null;
/** What the panel last rendered (compared instead of innerHTML, which the browser normalises). */
let panelHtml = '';

const serverNow = () => Date.now() + skew;

// ---- boot ---------------------------------------------------------------------------------------

async function boot() {
  try {
    const sprites = await loadSprites((d, t) => ($('connecting').textContent = `Loading art ${Math.round((100 * d) / t)}%`));
    view = new WorldView($<HTMLCanvasElement>('board'), sprites);
  } catch (e) {
    $('connecting').textContent = `Could not load the art: ${(e as Error).message}`;
    return;
  }
  $('connecting').textContent = 'Connecting...';
  // Dev-only handle for poking at the map from the browser console.
  if (import.meta.env.DEV) (window as unknown as { siege: unknown }).siege = { view, tap: (x: number, y: number) => tap(x, y) };
  const wrap = $('board-wrap');
  new ResizeObserver(() => view.fit(wrap.clientWidth, wrap.clientHeight)).observe(wrap);
  view.fit(wrap.clientWidth, wrap.clientHeight);
  net = new Net();
  bindInput();
  bindMinimap();
  bindNet();
  setInterval(updateWatch, 300);
  setInterval(() => {
    if (panel === 'other' || panel === 'live' || panel === 'mine') renderPanel();
    tickCountdowns();
    renderChips();
  }, 500);
  requestAnimationFrame(frame);
}

function frame(now: number) {
  view.draw(now);
  drawMinimap(now);
  renderBanner(now);
  requestAnimationFrame(frame);
}

// ---- network ------------------------------------------------------------------------------------

function bindNet() {
  const s = net.socket;
  s.on('connect', () => ($('connecting').hidden = true));
  s.on('disconnect', () => {
    $('connecting').textContent = 'Connection lost. Reconnecting...';
    $('connecting').hidden = false;
    watchKey = '';
  });
  s.on('connect_error', () => {
    $('connecting').textContent = 'Cannot reach the game server. Retrying...';
    $('connecting').hidden = false;
  });
  s.on('needLogin', () => {
    player = null;
    myRaid = null;
    centred = false;
    saveToken(null);
    view.myPlot = -1;
    view.myBase = null;
    view.deployPlot = -1;
    view.live.clear();
    for (const id of ['hud', 'panel', 'wave-banner', 'map-tools', 'attack-bar']) $(id).hidden = true;
    $('login').hidden = false;
  });
  s.on('welcome', (w: { token: string; player: PlayerView; offline: (OfflineSummary & { credited: number }) | null; feed: FeedItem[]; crate: CrateView | null }) => {
    saveToken(w.token);
    $('login').hidden = true;
    $('hud').hidden = false;
    $('wave-banner').hidden = false;
    $('map-tools').hidden = false;
    watchKey = '';
    setPlayer(w.player);
    setCrate(w.crate, true);
    if (!centred) {
      view.centerOnPlot(w.player.plot, view.baseZoom());
      centred = true;
    }
    $('feed').replaceChildren();
    for (const f of w.feed.slice(-3)) addFeed(f, true);
    if (w.offline) {
      const o = w.offline;
      const parts = [`While you were away: ${o.waves} wave${o.waves === 1 ? '' : 's'}`];
      if (o.breaches) parts.push(`${o.breaches} breach${o.breaches === 1 ? '' : 'es'} (-${o.coinsLost} coins)`);
      if (o.raids) parts.push(`raided ${o.raids} time${o.raids === 1 ? '' : 's'} (-${o.raidLosses ?? 0} coins)`);
      parts.push(`+${o.credited} coins banked${o.capped ? ' (bank was full)' : ''}`);
      toast(parts.join(', '), o.breaches || o.raids ? 'bad' : 'good', 7000);
    }
  });
  s.on('world', (m: { bases: BaseSummary[]; now: number; full?: boolean; raids?: RaidStatus[] }) => {
    skew = m.now - Date.now();
    view.clockSkew = skew;
    if (m.full) view.bases.clear();
    for (const b of m.bases) view.bases.set(b.p, b);
    if (m.raids && player) {
      const mine = m.raids.find((r) => r.attackerId === player!.id);
      if (mine) startRaidMode(mine, false);
      else if (myRaid) endRaidMode();
    }
    const n = [...view.bases.values()].filter((b) => b.raid).length;
    $('live-count').textContent = String(n);
    $('live-count').hidden = n === 0;
    if (panel === 'ranks' || panel === 'live' || panel === 'other') renderPanel();
  });
  s.on('live', onLive);
  s.on('wave', onLive);
  s.on('snap', (m: Snapshot & { p: number }) => view.applySnapshot(m.p, m, performance.now()));
  s.on('raid', (r: RaidStatus) => {
    const l = view.liveFor(r.plot);
    if (l.phase !== 'raid') {
      view.resetCombat(r.plot);
      l.phase = 'raid';
    }
    l.raid = r;
    if (myRaid && r.id === myRaid.id) {
      myRaid = r;
      renderAttackBar();
    }
  });
  s.on('underAttack', (r: RaidStatus) => toast(`${r.attacker} is raiding your base!`, 'bad', 5000));
  s.on('raidEnd', (r: RaidResult) => {
    const l = view.live.get(r.plot);
    if (l?.phase === 'raid') {
      l.phase = 'calm';
      l.raid = null;
      l.riseAt = performance.now() + CONFIG.waves.calm * 1000;
      clearLater(r.plot);
    }
    if (r.id === lastRaidEnd) return;
    lastRaidEnd = r.id;
    if (myRaid && r.id === myRaid.id) {
      endRaidMode();
      if (r.won) toast(`Raid won! ${r.destruction}% destroyed. +${r.loot} coins, +${r.trophies} trophies`, 'good', 6000);
      else toast(`Raid failed (${r.destruction}% destroyed). ${r.trophies} trophies`, 'bad', 6000);
    } else if (player && r.plot === player.plot) {
      if (r.won) toast(`${r.attacker} broke through and took ${r.loot} coins. Your base is shielded for a bit.`, 'bad', 6000);
      else toast(`You held off ${r.attacker}!`, 'good', 5000);
    }
  });
  s.on('coins', (c: { coins: number; delta: number }) => {
    if (!player) return;
    player.coins = c.coins;
    renderHud(c.delta);
    if (panel === 'mine') renderPanel();
    renderAttackBar();
  });
  s.on('player', (p: PlayerView) => setPlayer(p));
  s.on('waveEnd', (r: { p: number; breached: boolean; kills: number; coins: number; lost: number; total: number }) => {
    if (!player || r.p !== player.plot) return;
    player.coins = r.total;
    renderHud();
    if (panel === 'mine') renderPanel();
    if (r.breached) toast(`Breach! The Main Tower fell. Lost ${r.lost} coins.`, 'bad');
    else toast(`Wave held: ${r.kills} zombies down, +${r.coins} coins`, 'good', 2500);
  });
  s.on('feed', (f: FeedItem) => addFeed(f));
  s.on('crate', (c: CrateView | null) => setCrate(c, false));
}

function onLive(b: BaseLive) {
  const now = performance.now();
  const l = view.liveFor(b.p);
  l.phase = b.phase;
  l.raid = b.raid ?? null;
  if (b.nextIn !== undefined) l.riseAt = now + b.nextIn * 1000;
  if (b.snapshot) {
    view.resetCombat(b.p);
    view.applySnapshot(b.p, b.snapshot, now);
  }
  if (b.phase === 'calm') clearLater(b.p);
}

/** Let the last death animations play, then clear the field. */
function clearLater(plot: number) {
  setTimeout(() => {
    const l = view.live.get(plot);
    if (l && (l.phase === 'calm' || l.phase === 'warning')) view.resetCombat(plot);
  }, 900);
}

/** Area of interest: tell the server which bases this screen can see. */
function updateWatch() {
  if (!player || !net.socket.connected) return;
  const want: number[] = [];
  if (myRaid) want.push(myRaid.plot);
  if (focusPlot >= 0 && view.cam.k >= 2 && view.plotsOfInterest(64).includes(focusPlot)) want.push(focusPlot);
  for (const p of view.plotsOfInterest(WATCH_MAX + 2)) if (!want.includes(p) && p !== player.plot) want.push(p);
  const list = want.filter((p) => p !== player!.plot).slice(0, WATCH_MAX);
  const key = list.join(',');
  if (key === watchKey) return;
  watchKey = key;
  net.watch(list);
  for (const plot of [...view.live.keys()]) if (plot !== player.plot && !list.includes(plot)) view.live.delete(plot);
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

  const canvas = view.canvas;
  const pointers = new Map<number, { x: number; y: number }>();
  let moved = 0;
  let pinched = false;
  let pinchDist = 0;
  const local = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) {
      moved = 0;
      pinched = false;
    } else if (pointers.size === 2) {
      pinched = true;
      pinchDist = spread().d;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = local(e);
    if (pointers.size === 1) {
      moved += Math.hypot(cur.x - prev.x, cur.y - prev.y);
      if (moved > 8) {
        view.panBy(cur.x - prev.x, cur.y - prev.y);
        canvas.classList.add('dragging');
      }
      pointers.set(e.pointerId, cur);
    } else if (pointers.size === 2) {
      const before = spread();
      pointers.set(e.pointerId, cur);
      const after = spread();
      view.panBy(after.x - before.x, after.y - before.y);
      const ratio = after.d / pinchDist;
      if (ratio > 1.3 || ratio < 0.77) {
        view.zoomAt(ratio > 1 ? 1 : -1, after.x, after.y);
        pinchDist = after.d;
      }
    }
  });
  const up = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const pos = local(e);
    const wasTap = pointers.size === 1 && !pinched && moved <= 8;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) canvas.classList.remove('dragging');
    if (wasTap && e.type === 'pointerup') void tap(pos.x, pos.y);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  let wheelAt = 0;
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const now = performance.now();
      if (now - wheelAt < 120 || Math.abs(e.deltaY) < 2) return;
      wheelAt = now;
      const r = canvas.getBoundingClientRect();
      view.zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );

  const centre = () => [view.canvas.clientWidth / 2, view.canvas.clientHeight / 2] as const;
  $('zoom-in').addEventListener('click', () => view.zoomAt(1, ...centre()));
  $('zoom-out').addEventListener('click', () => view.zoomAt(-1, ...centre()));
  $('home-btn').addEventListener('click', () => {
    if (!player) return;
    view.centerOnPlot(player.plot, Math.max(view.cam.k, view.baseZoom()));
    openPanel('mine', player.plot);
  });
  $('ranks-btn').addEventListener('click', () => openPanel(panel === 'ranks' ? 'none' : 'ranks'));
  $('live-btn').addEventListener('click', () => openPanel(panel === 'live' ? 'none' : 'live'));
  $('crate-btn').addEventListener('click', () => openPanel(panel === 'crate' ? 'none' : 'crate'));
  $('panel').addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    if (form.id !== 'crate-form') return;
    e.preventDefault();
    void submitAnswer();
  });
  $('wave-banner').addEventListener('click', () => {
    if (player) view.centerOnPlot(player.plot, Math.max(view.cam.k, view.baseZoom()));
  });

  $('menu-btn').addEventListener('click', () => ($('menu').hidden = !$('menu').hidden));
  $('close-menu').addEventListener('click', () => ($('menu').hidden = true));
  $('logout-btn').addEventListener('click', () => {
    $('menu').hidden = true;
    saveToken(null);
    net.logout();
  });

  $('panel').addEventListener('click', (e) => void panelClick(e));
  $('troops').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-troop]');
    if (!btn || btn.disabled) return;
    troop = btn.dataset.troop as RaiderKind;
    renderAttackBar();
  });
  $('retreat-btn').addEventListener('click', () => {
    if (myRaid) net.retreat();
  });
}

async function tap(cssX: number, cssY: number) {
  if (!player) return;
  const [wx, wy] = view.toWorld(cssX, cssY);
  // Raiding: taps in the red zone send troops.
  if (myRaid && view.inDeploy(myRaid.plot, wx, wy)) {
    const r = await net.deploy(troop, wx / 16, wy / 16);
    if (r.ok) {
      player.coins = r.coins;
      renderHud();
      renderAttackBar();
    } else toast(r.error, 'bad', 2000);
    return;
  }
  if (view.crateAt(wx, wy)) {
    openPanel('crate');
    return;
  }
  const p = view.plotAt(wx, wy);
  if (myRaid && p?.id === myRaid.plot) {
    toast('Send raiders from the red ground outside their walls', '', 2000);
    return;
  }
  if (!p || !view.bases.has(p.id)) {
    openPanel('none');
    return;
  }
  if (p.id === player.plot) {
    if (view.cam.k < view.baseZoom()) view.centerOnPlot(p.id, view.baseZoom());
    view.selectedPick = view.pickInBase(p, wx, wy);
    openPanel('mine', p.id);
  } else openPanel('other', p.id);
}

async function panelClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (el.closest('[data-close]')) return openPanel('none');
  const jump = el.closest<HTMLElement>('[data-jump]');
  if (jump) return jumpTo(Number(jump.dataset.jump));
  if (el.closest('[data-crate-jump]')) {
    view.cam.x = CRATE_SPOT.x;
    view.cam.y = CRATE_SPOT.y;
    view.cam.k = Math.max(view.cam.k, 2);
    view.clamp();
    return;
  }
  const btn = el.closest<HTMLButtonElement>('button[data-act], button[data-attack], button[data-spectate], button[data-immunity]');
  if (!btn || btn.disabled) return;
  if (btn.dataset.immunity) {
    btn.disabled = true;
    const r = await net.buyImmunity(Number(btn.dataset.immunity));
    if (r.ok) {
      setPlayer(r.player);
      toast(`Immune to raids for ${btn.dataset.immunity} more minutes`, 'good', 2500);
    } else {
      toast(r.error, 'bad');
      renderPanel();
    }
    return;
  }
  if (btn.dataset.spectate) {
    const plot = Number(btn.dataset.spectate);
    focusPlot = plot;
    view.centerOnPlot(plot, Math.max(view.cam.k, view.baseZoom()));
    return;
  }
  if (btn.dataset.attack) {
    btn.disabled = true;
    const r = await net.attack(Number(btn.dataset.attack));
    if (r.ok) startRaidMode(r.raid, true);
    else {
      toast(r.error, 'bad');
      renderPanel();
    }
    return;
  }
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
}

/** Fly to a base from a list and open its card. */
function jumpTo(plot: number) {
  view.centerOnPlot(plot, Math.max(view.cam.k, view.baseZoom()));
  focusPlot = plot;
  if (player && plot === player.plot) openPanel('mine', plot);
  else openPanel('other', plot);
}

function startRaidMode(r: RaidStatus, fresh: boolean) {
  myRaid = r;
  focusPlot = r.plot;
  view.deployPlot = r.plot;
  $('attack-bar').hidden = false;
  $('board-wrap').classList.add('raiding');
  view.canvas.classList.add('deploying');
  if (fresh) {
    view.centerOnPlot(r.plot, Math.max(view.cam.k, view.baseZoom()));
    openPanel('none');
    toast('Raid on! Tap the red zone to send raiders.', '', 3000);
  }
  updateWatch();
  renderAttackBar();
}

function endRaidMode() {
  myRaid = null;
  view.deployPlot = -1;
  $('attack-bar').hidden = true;
  $('board-wrap').classList.remove('raiding');
  view.canvas.classList.remove('deploying');
}

// ---- minimap ------------------------------------------------------------------------------------

let miniBase: HTMLCanvasElement | null = null;

function bindMinimap() {
  const mini = $<HTMLCanvasElement>('minimap');
  let down = false;
  const go = (e: PointerEvent) => {
    const r = mini.getBoundingClientRect();
    view.cam.x = ((e.clientX - r.left) / r.width) * world.w * 16;
    view.cam.y = ((e.clientY - r.top) / r.height) * world.h * 16;
    view.clamp();
  };
  mini.addEventListener('pointerdown', (e) => {
    down = true;
    mini.setPointerCapture(e.pointerId);
    go(e);
  });
  mini.addEventListener('pointermove', (e) => down && go(e));
  mini.addEventListener('pointerup', () => (down = false));
  mini.addEventListener('pointercancel', () => (down = false));
}

function drawMinimap(now: number) {
  const mini = $<HTMLCanvasElement>('minimap');
  const g = mini.getContext('2d')!;
  if (!miniBase) {
    miniBase = document.createElement('canvas');
    miniBase.width = world.w;
    miniBase.height = world.h;
    const b = miniBase.getContext('2d')!;
    const img = b.createImageData(world.w, world.h);
    const colors = [[66, 58, 40], [104, 92, 70], [48, 38, 30]];
    for (let i = 0; i < world.w * world.h; i++) {
      const c = colors[world.ground[i]!]!;
      img.data.set([c[0]!, c[1]!, c[2]!, 255], i * 4);
    }
    b.putImageData(img, 0, 0);
  }
  g.drawImage(miniBase, 0, 0);
  const pulse = Math.sin(now / 200) > 0;
  for (const p of world.plots) {
    const s = view.bases.get(p.id);
    if (!s) {
      g.fillStyle = '#2a241c';
      g.fillRect(p.x + 2, p.y + 2, PLOT - 4, PLOT - 4);
      continue;
    }
    g.fillStyle = player && p.id === player.plot ? '#e3b341' : s.raid ? (pulse ? '#e0573f' : '#7a3424') : '#a89878';
    g.fillRect(p.x + 2, p.y + 2, PLOT - 4, PLOT - 4);
  }
  for (const gy of world.graveyards) {
    const w = Math.max(0, ...gy.serves.map((id) => view.bases.get(id)?.wave ?? 0));
    g.fillStyle = w === 2 ? (pulse ? '#e0573f' : '#5a1f14') : w === 1 ? '#e38b41' : '#4a3b2c';
    g.fillRect(gy.x, gy.y, 5, 5);
  }
  if (view.crate) {
    g.fillStyle = pulse ? '#fff3b0' : view.crate.rarity === 'legendary' ? '#e0573f' : view.crate.rarity === 'epic' ? '#6ea0e6' : '#8fc46b';
    g.fillRect(Math.round(CRATE_SPOT.x / 16) - 3, Math.round(CRATE_SPOT.y / 16) - 3, 6, 6);
  }
  const [x0, y0, x1, y1] = view.viewRect();
  g.strokeStyle = '#f1e6cf';
  g.lineWidth = 1;
  g.strokeRect(Math.round(x0 / 16) + 0.5, Math.round(y0 / 16) + 0.5, Math.round((x1 - x0) / 16) - 1, Math.round((y1 - y0) / 16) - 1);
}

// ---- rendering ----------------------------------------------------------------------------------

function setPlayer(p: PlayerView) {
  player = p;
  view.myPlot = p.plot;
  view.myBase = p.base;
  renderHud();
  renderChips();
  if (panel === 'mine' || panel === 'other') renderPanel();
  renderAttackBar();
}

/** Small status chips under the name: immunity/shield and active boosts. */
function renderChips() {
  if (!player) return;
  const now = serverNow();
  const chips: string[] = [];
  const prot = Math.max(player.immuneUntil, player.shieldUntil);
  if (prot > now) chips.push(`<span class="chip shield">${player.immuneUntil > now ? 'Immune' : 'Shield'} ${clock(prot - now)}</span>`);
  const b = liveBoosts(player.boosts, now);
  if (b.attack) chips.push(`<span class="chip">ATK +${Math.round(b.attack.pct * 100)}% ×${b.attack.uses}</span>`);
  if (b.defence) chips.push(`<span class="chip">DEF +${Math.round(b.defence.pct * 100)}% ${clock(b.defence.until - now)}</span>`);
  if (b.loot) chips.push(`<span class="chip">LOOT +${Math.round(b.loot.pct * 100)}%</span>`);
  const html = chips.join('');
  const el = $('hud-chips');
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

/** Countdowns inside panels: <span data-until="serverMs">, updated in place so panels don't re-render. */
function tickCountdowns() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-until]')) el.textContent = clock(Number(el.dataset.until) - serverNow());
}

function setCrate(c: CrateView | null, quiet: boolean) {
  const prev = crate;
  crate = c;
  const open = !!c && !c.claimedBy;
  view.crate = open ? { rarity: c!.rarity } : null;
  $('crate-badge').hidden = !open;
  $('crate-btn').classList.toggle('on', open);
  if (!quiet && c) {
    if (!prev || prev.id !== c.id) toast(`A ${c.rarity} crate dropped at the crossroads! Tap Crate to answer.`, '', 5000);
    else if (c.claimedBy && !prev.claimedBy && player && c.claimedBy !== player.name) toast(`${c.claimedBy} claimed the crate.`, '', 3500);
  }
  if (panel === 'crate') renderPanel();
}

let answerBusy = false;
async function submitAnswer() {
  const input = document.getElementById('crate-answer') as HTMLInputElement | null;
  const msg = document.getElementById('crate-msg');
  const btn = document.getElementById('crate-go') as HTMLButtonElement | null;
  if (!crate || !input || !msg || !btn || answerBusy || !input.value.trim()) return;
  answerBusy = true;
  btn.disabled = true;
  const r = await net.answer(crate.id, input.value);
  answerBusy = false;
  if (!r.ok) {
    msg.className = 'crate-msg bad';
    msg.textContent = r.error;
    btn.disabled = false;
    return;
  }
  if (r.correct) {
    msg.className = 'crate-msg good';
    msg.textContent = `Correct! You won: ${r.reward}`;
    toast(`Crate claimed! ${r.reward}`, 'good', 5000);
    return;
  }
  const wait = r.retryIn ?? 3;
  msg.className = 'crate-msg bad';
  msg.textContent = `Not quite. Try again in ${wait}s.`;
  input.select();
  setTimeout(() => {
    btn.disabled = false;
    if (msg.textContent?.startsWith('Not quite')) msg.textContent = '';
  }, wait * 1000);
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

function renderBanner(now: number) {
  if (!player) return;
  const l = view.live.get(player.plot);
  const b = $('wave-banner');
  let text = 'All quiet.';
  let attack = false;
  if (l?.phase === 'raid') {
    text = `⚔ ${l.raid?.attacker ?? 'Someone'} is raiding your base! (${l.raid?.destruction ?? 0}% destroyed)`;
    attack = true;
  } else if (l?.phase === 'wave') {
    text = 'Zombies rising from the graveyard!';
    attack = true;
  } else if (l) {
    const s = Math.max(0, Math.ceil((l.riseAt - now) / 1000));
    if (l.phase === 'warning' || (s > 0 && s <= CONFIG.waves.warning)) {
      text = `Zombies rising from the graveyard in ${s}s!`;
      attack = true;
    } else text = s > 0 ? `All quiet. Next wave in ${s}s` : 'The ground is moving...';
  }
  if (b.textContent !== text) b.textContent = text;
  b.classList.toggle('attack', attack);
}

function renderAttackBar() {
  if (!myRaid || !player) return;
  const t = Math.max(0, myRaid.left);
  $('raid-title').textContent = `Raiding ${myRaid.defender}`;
  $('raid-time').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  $('raid-dmg').textContent = `${myRaid.destruction}%`;
  const html = RAIDER_KINDS.map((k) => {
    const c = CONFIG.pvp.raiders[k];
    const locked = !raiderUnlocked(k, player!.base.hq);
    const poor = player!.coins < c.cost;
    const sub = locked ? `Main Tower Lv ${c.unlockHq}` : `${c.cost} coins`;
    return `<button class="troop ${k === troop ? 'on' : ''}" data-troop="${k}" ${locked || poor ? 'disabled' : ''}>${RAIDER_NAME[k]}<small>${sub}</small></button>`;
  }).join('');
  if ($('troops').innerHTML !== html) $('troops').innerHTML = html;
}

function openPanel(mode: PanelMode, plot = -1) {
  panel = mode;
  selectedPlot = plot;
  if (mode !== 'mine') view.selectedPick = null;
  view.selectedPlot = mode === 'mine' || mode === 'other' ? plot : -1;
  $('panel').hidden = mode === 'none';
  renderPanel();
}

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function head(title: string) {
  return `<div class="panel-head"><h2>${title}</h2><button class="close" data-close aria-label="Close">&times;</button></div>`;
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

function clock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderPanel() {
  const el = $('panel');
  if (!player || panel === 'none') return;
  let html = '';
  if (panel === 'mine') html = minePanel();
  else if (panel === 'other') html = otherPanel();
  else if (panel === 'ranks') html = ranksPanel();
  else if (panel === 'crate') html = cratePanel();
  else html = livePanel();
  if (html === panelHtml) return;
  panelHtml = html;
  el.innerHTML = html;
  tickCountdowns();
}

/** A countdown filled in by tickCountdowns (empty here so the panel's HTML doesn't change every second). */
const until = (ms: number) => `<span data-until="${ms}"></span>`;

function cratePanel(): string {
  const c = crate;
  const prize = `<p class="note">Prize: one random boost (stronger crates give stronger boosts): ${boostLabel('attack', CONFIG.crates.boosts.attack.pct.rare).replace('+25%', '+25-60%')}, ${boostLabel('defence', CONFIG.crates.boosts.defence.pct.rare).replace('+25%', '+25-60%')} or ${boostLabel('loot', CONFIG.crates.boosts.loot.pct.rare).replace('+50%', '+50-100%')}.</p>`;
  if (!c) return `${head('Crates')}<p class="sub">Every ${CONFIG.crates.every / 60} minutes a crate drops at the crossroads with a coding question. The first correct answer wins it.</p><p class="note">The first crate drops soon.</p>${prize}`;
  const title = `<span class="rarity r-${c.rarity}">${c.rarity}</span> crate`;
  const code = c.code ? `<pre class="code" data-lang="${esc(c.lang)}">${esc(c.code)}</pre>` : '';
  const question = `<p class="q-prompt">${esc(c.prompt)}</p>${code}`;
  if (c.claimedBy) {
    const mine = player && c.claimedBy === player.name;
    return `${head(title)}<p class="sub">${mine ? 'You' : esc(c.claimedBy)} cracked it: <b>${esc(c.reward ?? '')}</b></p>${question}<p class="answer-reveal">Answer: <code>${esc(c.answer ?? '')}</code></p><p class="note">Next crate in ${until(c.expiresAt)}.</p>`;
  }
  return `${head(title)}<p class="sub">First correct answer wins it. Expires in ${until(c.expiresAt)}.</p>${question}<form id="crate-form" class="crate-form" autocomplete="off"><input id="crate-answer" maxlength="120" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="${c.kind === 'fill-blank' ? 'What goes in the blank?' : 'What does it print?'}" /><button class="btn" id="crate-go">Submit</button></form><p class="crate-msg" id="crate-msg"></p><button class="link" data-crate-jump>Show it on the map</button>${prize}`;
}

function otherPanel(): string {
  const s = view.bases.get(selectedPlot);
  if (!s) return `${head('Ruins')}<p class="sub">Nobody lives here yet.</p>`;
  const now = serverNow();
  const shielded = s.shield > now;
  const immune = s.immune > now;
  let status = '<span class="status">Calm</span>';
  if (s.raid) status = `<span class="status bad">⚔ Under attack by ${esc(s.raider ?? 'someone')}</span>`;
  else if (immune) status = `<span class="status shield">Immune ${until(s.immune)}</span>`;
  else if (shielded) status = `<span class="status shield">Shielded ${until(s.shield)}</span>`;
  else if (s.wave === 2) status = '<span class="status bad">Fighting zombies</span>';
  else if (s.wave === 1) status = '<span class="status">Zombies rising</span>';
  let why = '';
  if (myRaid) why = myRaid.plot === s.p ? "You're raiding this base" : 'Finish your current raid first';
  else if (s.raid) why = 'Already under attack';
  else if (immune) why = 'Bought immunity from raids';
  else if (shielded) why = 'Shielded for a while after a raid';
  const win = trophyStake(player!.trophies, s.trophies);
  const posts = s.posts.filter(Boolean).length;
  return `${head(esc(s.name))}<p class="sub">${status}</p>${stats([
    ['Main Tower', `Lv ${s.hq}`],
    ['Trophies', s.trophies],
    ['Lootable', `~${s.loot}`],
    ['Walls', `Lv ${s.walls}`],
    ['Posts', posts],
    ['Win', `+${win} ♛`],
  ])}<div class="actions"><button class="btn" data-attack="${s.p}" ${why ? 'disabled' : ''}>Attack<small>${why ? esc(why) : 'Raiders cost coins to send'}</small></button><button class="btn secondary" data-spectate="${s.p}">Spectate<small>Watch this base</small></button></div>`;
}

function ranksPanel(): string {
  const list = [...view.bases.values()].sort((a, b) => b.trophies - a.trophies || b.hq - a.hq).slice(0, 50);
  const rows = list
    .map((b, i) => `<li><button data-jump="${b.p}" class="${player && b.id === player.id ? 'me' : ''}"><span class="rank">#${i + 1}</span><span class="nm">${esc(b.name)} <small>Lv${b.hq}</small></span><span class="val">♛ ${b.trophies}</span></button></li>`)
    .join('');
  return `${head('Leaderboard')}<p class="sub">Tap a name to fly to their base.</p><ul class="list">${rows || '<li class="empty">No one yet.</li>'}</ul>`;
}

function livePanel(): string {
  const list = [...view.bases.values()].filter((b) => b.raid);
  const rows = list
    .map((b) => {
      const l = view.live.get(b.p)?.raid;
      const extra = l ? `${l.destruction}% · ${clock(l.left * 1000)}` : 'live';
      return `<li><button data-jump="${b.p}"><span class="nm">${esc(b.raider ?? '?')} ⚔ ${esc(b.name)}</span><span class="val">${extra}</span></button></li>`;
    })
    .join('');
  return `${head('Live battles')}<p class="sub">Tap a battle to watch it.</p><ul class="list">${rows || '<li class="empty">No raids right now.</li>'}</ul>`;
}

function minePanel(): string {
  const base = player!.base;
  const sel = view.selectedPick;
  const l = view.live.get(player!.plot);
  const waveNote = l?.phase === 'wave' || l?.phase === 'raid' ? '<p class="note">A fight is on: changes join the next one.</p>' : '';
  if (!sel) {
    const posts = base.posts.filter(Boolean).length;
    const now = serverNow();
    const me = player!;
    const prot = me.immuneUntil > now ? `Immune for ${until(me.immuneUntil)}` : me.shieldUntil > now ? `Shielded for ${until(me.shieldUntil)}` : 'Not protected';
    const left = Math.max(0, me.immuneUntil - now);
    const immunity = CONFIG.immunity.options
      .map((o) => {
        const tooLong = left + o.minutes * 60_000 > CONFIG.immunity.maxMinutes * 60_000;
        const poor = me.coins < o.cost;
        const sub = tooLong ? `Max ${CONFIG.immunity.maxMinutes} min` : poor ? `${o.cost} coins · Need ${o.cost - me.coins} more` : `${o.cost} coins`;
        return `<button class="btn secondary" data-immunity="${o.minutes}" ${tooLong || poor || myRaid ? 'disabled' : ''}>${o.minutes} min immunity<small>${sub}</small></button>`;
      })
      .join('');
    const b = liveBoosts(me.boosts, now);
    const boosts = [
      b.attack ? `<li>${esc(boostLabel('attack', b.attack.pct).replace(/\(.*\)/, ''))} · ${b.attack.uses} raid${b.attack.uses === 1 ? '' : 's'} left</li>` : '',
      b.defence ? `<li>${esc(boostLabel('defence', b.defence.pct).replace(/\(.*\)/, ''))} · ${until(b.defence.until)} left</li>` : '',
      b.loot ? `<li>${esc(boostLabel('loot', b.loot.pct))}</li>` : '',
    ].join('');
    return `${head('Your base')}<p class="sub">Tap the Main Tower, a wall or a post slot to build and upgrade.</p>${stats([
      ['Main Tower', `Lv ${base.hq}`],
      ['Walls', `Lv ${base.walls}`],
      ['Posts', `${posts}/${slotsUnlocked(base.hq)}`],
    ])}<h3>Raid protection</h3><p class="sub">${prot}. Immunity stops raids, not zombies, and ends if you attack someone.</p><div class="actions">${immunity}</div><h3>Crate boosts</h3>${boosts ? `<ul class="boosts">${boosts}</ul>` : '<p class="sub">None yet. Win a crate by answering its question first.</p>'}<p class="note">Zombies rise from your graveyard every few seconds. Every kill pays coins, even while you're away (up to ${CONFIG.offline.bankCap}).</p>`;
  }
  if (sel.kind === 'hq') {
    const next = base.hq + 1;
    const unlocks: string[] = [];
    if (next <= CONFIG.hq.maxLevel) {
      const moreSlots = slotsUnlocked(next) - slotsUnlocked(base.hq);
      if (moreSlots > 0) unlocks.push(`+${moreSlots} post slot`);
      for (const t of POST_TYPES) if (CONFIG.hq.postUnlock[t] === next) unlocks.push(`${POST_NAME[t]}s`);
      for (const k of RAIDER_KINDS) if (CONFIG.pvp.raiders[k].unlockHq === next) unlocks.push(`${RAIDER_NAME[k]} raiders`);
      unlocks.push(`posts & walls up to Lv ${next}`);
    }
    return `${head(`Main Tower · Lv ${base.hq}`)}<p class="sub">The heart of your base. If zombies destroy it you lose some coins; raiders who destroy it win. Its level caps everything else.</p>${stats([
      ['Health', CONFIG.hq.hp(base.hq)],
      ['Post slots', `${slotsUnlocked(base.hq)}/8`],
      ['Next level', next <= CONFIG.hq.maxLevel ? unlocks.join(', ') : 'Max'],
    ])}<div class="actions">${button(`Upgrade to Lv ${next}`, { kind: 'hq' })}</div>${waveNote}`;
  }
  if (sel.kind === 'walls') {
    const kind = base.walls >= CONFIG.walls.reinforcedFromLevel ? 'Reinforced' : 'Wooden';
    const nextKind = base.walls + 1 >= CONFIG.walls.reinforcedFromLevel ? 'reinforced' : 'wooden';
    return `${head(`Walls · Lv ${base.walls}`)}<p class="sub">${kind} walls ring your base. Axe zombies and brutes hit them hard.</p>${stats([
      ['Health each', CONFIG.walls.hp(base.walls)],
      ['Next level', base.walls < CONFIG.walls.maxLevel ? `${CONFIG.walls.hp(base.walls + 1)} (${nextKind})` : 'Max'],
    ])}<div class="actions">${button(`Upgrade to Lv ${base.walls + 1}`, { kind: 'walls' })}</div>${waveNote}`;
  }
  const slot = sel.slot;
  const p = base.posts[slot];
  if (slot >= slotsUnlocked(base.hq)) {
    const need = CONFIG.hq.slotsUnlocked.findIndex((n) => n > slot) + 1;
    return `${head('Locked slot')}<p class="sub">Upgrade the Main Tower to Lv ${need} to build here.</p>`;
  }
  if (!p) {
    const opts = POST_TYPES.map((t) => {
      const st = postStats(t, 1);
      return button(POST_NAME[t], { kind: 'build', slot, type: t }, `<small>dmg ${st.damage} · range ${st.range} · every ${st.cooldown}s</small>`);
    }).join('');
    return `${head('Empty slot')}<p class="sub">Station a survivor behind a barricade.</p><div class="actions">${opts}</div>${waveNote}`;
  }
  const now = postStats(p.type, p.level);
  const nx = p.level < CONFIG.posts.maxLevel ? postStats(p.type, p.level + 1) : null;
  return `${head(`${POST_NAME[p.type]} · Lv ${p.level}`)}<p class="sub">${p.type === 'shotgun' ? 'Short range, hits a whole group.' : p.type === 'gun' ? 'Long range, hard hitting.' : 'Quick shots, decent range.'}${p.level < CONFIG.posts.helmetFromLevel ? ` Gets a helmet at Lv ${CONFIG.posts.helmetFromLevel}.` : ''}</p>${stats([
    ['Damage', nx ? `${now.damage} → ${nx.damage}` : now.damage],
    ['Health', nx ? `${now.hp} → ${nx.hp}` : now.hp],
    ['Range', now.range],
    ['Fires every', `${now.cooldown}s`],
  ])}<div class="actions">${button(`Upgrade to Lv ${p.level + 1}`, { kind: 'post', slot })}</div>${waveNote}`;
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

function addFeed(f: FeedItem, quiet = false) {
  const el = document.createElement('div');
  el.className = f.kind;
  el.textContent = f.text;
  const feed = $('feed');
  feed.append(el);
  while (feed.children.length > 3) feed.firstElementChild!.remove();
  setTimeout(() => el.classList.add('old'), quiet ? 4000 : 9000);
  setTimeout(() => el.remove(), quiet ? 5000 : 10000);
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
