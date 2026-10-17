import {
  COMMANDER_WEAPONS,
  POWERS,
  abilityUnlocked,
  commanderWeapon,
  powersUnlockedAt,
  weaponLevel,
  weaponStats,
  type AbilityId,
  type PowerInfo,
  CONFIG,
  PLOT,
  POST_TYPES,
  RAIDER_KINDS,
  boostLabel,
  getWorld,
  inOtherPlot,
  inTapReach,
  BASIC_BASE,
  basicBaseDone,
  liveBoosts,
  lootable,
  postStats,
  quote,
  raiderCost,
  raiderUnlocked,
  slotsUnlocked,
  trophyStake,
  type BaseAction,
  type BaseState,
  type BaseSummary,
  type CrateView,
  type FeedItem,
  type OfflineSummary,
  type PlayerView,
  type PostType,
  type RaidResult,
  type RaidStatus,
  type RaiderKind,
} from '@siege/shared';
import { SERVER_URL } from './config.ts';
import { Net, saveToken, savedToken } from './net.ts';
import { sfx } from './retro.ts';
import { loadSprites } from './sprites.ts';
import { bindLiveStream, type SiegeMessage, type TapMessage } from './stream.ts';
import { THEME, baseColor, loadFonts } from './theme.ts';
import { TitleScreen } from './title.ts';
import { CRATE_SPOT, WorldView } from './world.ts';

// Game page controller: login, HUD, the shared map (pan / zoom / tap), base cards, raids, lists.
// Everything shown comes from the server; buttons only send intents.

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
/** Organiser switches: game paused, leaderboard frozen. */
let org = { paused: false, frozen: false };
/** Your own base's siege, from the server's 'pressure' updates (twice a second). */
let siege: { n: number; phase: string; nextIn: number; sides: number[]; hq: number; at: number; incoming: number[]; tutorial: boolean; guided: boolean; early: number; earlyOpensIn: number; defence: number; next: number; horde: boolean; surges: number } | null = null;
/** Guidance is over (the basic base is built): show "Base ready!" once, the moment it happens. */
let wasGuided: boolean | null = null;
/** The walkthrough: which prompt is up (0 none), and since when. */
let coachStep = 0;
let coachAt = 0;
let coachKills = 0;
let coachPosts = 0;
/** A message that takes over the banner for a moment (surge held, breach, the first surge). */
let flash: { text: string; cls: string; until: number } | null = null;
/** Next time a growl may play (ms). */
let nextGrowl = 0;
/**
 * The Commander's gun as this screen predicts it (local ms); every server answer and the twice-a-second
 * pressure update set it back to the server's numbers.
 */
const gun = { mag: 0, reloadEnd: 0, nextShot: 0, weapon: -1, combo: 0, mult: 1, airReadyAt: 0, molReadyAt: 0, ultReadyAt: 0, squadReadyAt: 0, ally: 0 };
/** Waiting for a tap on the map: where to drop an airstrike, throw a molotov, or send the squad member. */
let aiming: 'airstrike' | 'molotov' | 'order' | null = null;
/** Dragging your squad member to a new spot (the drag started on them). */
let squadDrag = false;
/** Which survivor from the raider roster you summon as your squad member (remembered on this phone). */
let squadKind: RaiderKind = (() => {
  try {
    const k = localStorage.getItem('siege.squad');
    if (k && (RAIDER_KINDS as readonly string[]).includes(k)) return k as RaiderKind;
  } catch {
    /* private mode */
  }
  return 'r_helmet';
})();
const CMD = CONFIG.commander;
const WEAPON_NAME = { pistol: 'Pistol', gun: 'Gun', shotgun: 'Shotgun' } as const;
/** The arcade title screen (shown to anyone not logged in). */
const title = new TitleScreen($('title'), {
  login: (name, roll) => net.login(name, roll),
  summaryUrl: `${SERVER_URL ?? ''}/api/summary`,
});

const serverNow = () => Date.now() + skew;

// ---- boot ---------------------------------------------------------------------------------------

async function boot() {
  try {
    const [sprites] = await Promise.all([loadSprites((d, t) => ($('connecting').textContent = `Loading art ${Math.round((100 * d) / t)}%`)), loadFonts().then(() => title.init())]);
    view = new WorldView($<HTMLCanvasElement>('board'), sprites);
    view.prebake();
  } catch (e) {
    $('connecting').textContent = `Could not load the art: ${(e as Error).message}`;
    return;
  }
  $('connecting').textContent = 'Connecting...';
  // Dev-only handle for poking at the map from the browser console.
  if (import.meta.env.DEV) (window as unknown as { siege: unknown }).siege = { view, tap: (x: number, y: number) => tap(x, y), frame: (now: number) => frame(now) };
  const wrap = $('board-wrap');
  new ResizeObserver(() => view.fit(wrap.clientWidth, wrap.clientHeight)).observe(wrap);
  view.fit(wrap.clientWidth, wrap.clientHeight);
  net = new Net();
  // New visitors get the title screen straight away (even before the server answers).
  if (!savedToken()) showTitle();
  bindInput();
  bindMinimap();
  bindNet();
  setInterval(updateWatch, 300);
  setInterval(() => {
    if (panel === 'other' || panel === 'live' || panel === 'mine') renderPanel();
    tickCountdowns();
    renderChips();
    renderModeToggle();
  }, 500);
  requestAnimationFrame(frame);
}

/** Your own Main Tower took damage: pulse the red vignette (stronger when it's low). */
function hurt(hp: number, drop: number) {
  const el = $('hurt');
  el.style.setProperty('--hurt', String(Math.min(1, 0.35 + drop / 12 + (100 - hp) / 140)));
  el.classList.remove('pulse');
  void el.offsetWidth; // restart the animation
  el.classList.add('pulse');
}

/** Growls layered with the pressure on your base, panned toward the side it's coming from. */
function growls(now: number) {
  if (!siege || now < nextGrowl || now - siege.at > 3000) return;
  const [n, e, so, w] = siege.sides as [number, number, number, number];
  const total = n + e + so + w;
  if (total < 3) {
    nextGrowl = now + 800;
    return;
  }
  // The busier it gets, the more often they growl (from every ~1.6 s to several a second).
  nextGrowl = now + Math.max(220, 1600 - total * 22) * (0.6 + Math.random() * 0.8);
  const pan = (e - w) / Math.max(1, e + w) * 0.8 + (Math.random() - 0.5) * 0.3;
  sfx.growl(pan, Math.min(1, 0.35 + total / 60));
}

function showTitle() {
  $('connecting').hidden = true;
  title.show();
}

const FRAME_STEPS: [string, (now: number) => void][] = [
  ['update', (now) => view.update(now)],
  ['draw', (now) => view.draw(now)],
  ['minimap', drawMinimap],
  ['banner', renderBanner],
  ['growls', growls],
  ['cmdBar', renderCmdBar],
  ['coach', tickCoach],
];
let lastFrame = 0;

function frame(now: number) {
  if (import.meta.env.DEV) {
    // Dev only: a frame that took long (or a long gap since the last one) is logged with what took the time.
    const took: string[] = [];
    let total = 0;
    for (const [name, step] of FRAME_STEPS) {
      const t = performance.now();
      step(now);
      const d = performance.now() - t;
      total += d;
      if (d > 8) took.push(`${name} ${d.toFixed(0)}ms`);
    }
    const gap = lastFrame ? now - lastFrame : 0;
    if (!document.hidden && (total > 50 || gap > 250)) console.warn(`[siege] slow frame: ${total.toFixed(0)}ms of work, ${gap.toFixed(0)}ms since the last frame${took.length ? ` (${took.join(', ')})` : ''}`);
    lastFrame = now;
  } else for (const [, step] of FRAME_STEPS) step(now);
  requestAnimationFrame(frame);
}

// ---- network ------------------------------------------------------------------------------------

function bindNet() {
  const s = net.socket;
  // The "connecting" overlay is for players in the game; the title screen handles being offline itself.
  s.on('connect', () => ($('connecting').hidden = true));
  s.on('disconnect', () => {
    $('connecting').textContent = 'Connection lost. Reconnecting...';
    $('connecting').hidden = title.shown;
    watchKey = '';
  });
  s.on('connect_error', () => {
    $('connecting').textContent = 'Cannot reach the game server. Retrying...';
    $('connecting').hidden = title.shown;
  });
  s.on('needLogin', () => {
    player = null;
    myRaid = null;
    centred = false;
    saveToken(null);
    view.myPlot = -1;
    view.myBase = null;
    view.deployPlot = -1;
    view.pressure = null;
    siege = null;
    flash = null;
    for (const plot of [...view.live.keys()]) view.dropLive(plot);
    for (const id of ['hud', 'panel', 'banner-row', 'map-tools', 'attack-bar']) $(id).hidden = true;
    showTitle();
  });
  s.on('welcome', (w: { token: string; player: PlayerView; offline: (OfflineSummary & { credited: number }) | null; feed: FeedItem[]; crate: CrateView | null }) => {
    saveToken(w.token);
    title.hide();
    $('hud').hidden = false;
    $('banner-row').hidden = false;
    $('map-tools').hidden = false;
    watchKey = '';
    setPlayer(w.player);
    setCrate(w.crate, true);
    if (!centred) {
      // Land right on your own base: the zombies are about to come at it from every side.
      view.centerOnPlot(w.player.plot, view.overviewZoom());
      centred = true;
    }
    $('feed').replaceChildren();
    for (const f of w.feed.slice(-3)) addFeed(f, true);
    if (w.offline) {
      const o = w.offline;
      const parts = [`While you were away: ${o.waves} zombie surge${o.waves === 1 ? '' : 's'}`];
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
  bindLiveStream(s, view);
  s.on('raid', (r: RaidStatus) => {
    if (myRaid && r.id === myRaid.id) {
      myRaid = r;
      renderAttackBar();
    }
  });
  s.on('underAttack', (r: RaidStatus) => toast(`${r.attacker} is raiding your base!`, 'bad', 5000));
  s.on('raidEnd', (r: RaidResult) => {
    if (r.id === lastRaidEnd) return;
    lastRaidEnd = r.id;
    if (myRaid && r.id === myRaid.id) {
      endRaidMode();
      if (r.reason === 'cancelled') toast('Raid called off: nothing was sent, so it cost nothing.', '', 5000);
      else if (r.won) toast(`${starText(r.stars)} Raid won! ${r.destruction}% destroyed${r.vault ? ', vault cracked' : ''}. +${r.loot} coins, +${r.trophies} trophies`, 'good', 6000);
      else toast(`Raid failed (${r.destruction}% destroyed${r.loot ? `, +${r.loot} coins` : ''}). ${r.trophies} trophies`, 'bad', 6000);
    } else if (player && r.plot === player.plot) {
      if (r.reason === 'cancelled') return;
      if (r.won) toast(`${r.attacker} raided you ${starText(r.stars)} and took ${r.loot} coins. Your base is shielded for a bit.`, 'bad', 6000);
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
  // A pause ran out on its own.
  s.on('paused', () => toast('Pause over: surges are coming back', '', 3000));
  s.on('siege', (m: SiegeMessage) => {
    if (!player || m.p !== player.plot) return;
    const now = performance.now();
    const S = THEME.siege.shake;
    if (m.type === 'surge') {
      view.incoming = [];
      const from = (m.sides ?? []).map((n, i) => [n, i] as const).filter(([n]) => n > 0).map(([, i]) => SIDE_LABEL[i] ?? 'graveyard');
      if (m.tutorial) {
        flash = { text: `☠ Zombies from the ${from[0]}!`, cls: 'alarm', until: now + 2500 };
        coach(1);
        sfx.siren(false);
      } else if (m.horde) {
        flash = { text: '☠ HORDE! A much bigger surge is here!', cls: 'alarm', until: now + 3000 };
        view.shake(S.first * view.dpr, 600);
        sfx.siren(true);
      } else if (m.boss) {
        flash = { text: '☠ A BOSS is coming! Focus it down!', cls: 'alarm', until: now + 3200 };
        view.shake(S.first * view.dpr, 700);
        sfx.siren(true);
      } else if (m.n === 1) {
        flash = { text: `⚠ Zombies from the ${from.join(', ')}!`, cls: 'alarm', until: now + 3000 };
        view.shake(S.pincer * view.dpr, 400);
        sfx.siren(true);
      } else if (m.pincer) {
        const from = (m.sides ?? []).map((n, i) => [n, i] as const).filter(([n, i]) => i < 4 && n >= Math.max(3, (m.size ?? 0) * 0.2)).map(([, i]) => SIDE_LABEL[i]);
        flash = { text: `⚔ Pincer from the ${from.join(' and ')}!`, cls: 'alarm', until: now + 2200 };
        view.shake(S.pincer * view.dpr, 300);
        sfx.siren(false);
      }
    } else if (m.type === 'held') {
      if (!flash || flash.until < now + 500) flash = { text: `Surge ${m.n} held! ${m.kills} down, +${m.coins} coins${m.bonus ? ` (${m.bonus} bonus)` : ''}`, cls: 'held', until: now + 2200 };
      sfx.held();
      if (coachStep && coachStep < 3) coach(3);
    } else if (m.type === 'rage') {
      flash = { text: "😡 They're enraged! Finish them off!", cls: 'alarm', until: now + 2500 };
      sfx.siren(false);
    } else if (m.type === 'strike') {
      view.shake(S.strike * view.dpr, 350);
      sfx.boom();
    } else if (m.type === 'bomb') {
      flash = { text: `💣 Carpet bomb! ${m.kills} down${m.coins ? `, +${m.coins} coins` : ''}`, cls: 'held', until: now + 2500 };
      view.shake(S.breach * view.dpr, 700);
      sfx.boom();
    } else if (m.type === 'paused') {
      flash = null;
      sfx.held();
    } else if (m.type === 'squad') {
      toast(`Your squad member is down. Back in ${CMD.squad.cooldown}s`, 'bad', 2500);
      gun.ally = 0;
      if (aiming === 'order') aiming = null;
    } else if (m.type === 'breach') {
      if (m.total !== undefined) player.coins = m.total;
      renderHud();
      if (panel === 'mine') renderPanel();
      flash = { text: `💥 Breach! The Main Tower fell: -${m.lost ?? 0} coins. Regroup!`, cls: 'alarm', until: now + 3500 };
      view.shake(S.breach * view.dpr, 600);
      hurt(0, 40);
      sfx.boom();
    }
  });
  s.on('pressure', (m: { p: number; sides: number[]; hq: number; n: number; phase: string; nextIn: number; incoming: number[]; tutorial: boolean; guided: boolean; early: number; earlyOpensIn: number; defence: number; next: number; horde: boolean; toughness: number; surges: number; ammo: { mag: number; reload: number; weapon: number; airIn: number; molIn: number; ultIn: number; squadIn: number; ally: number; combo: number } }) => {
    if (!player || m.p !== player.plot) return;
    const now = performance.now();
    // Resync the gun unless a shot is in flight (the prediction is fresher for a moment).
    if (now - gun.nextShot > 300) {
      gun.mag = m.ammo.mag;
      gun.reloadEnd = m.ammo.reload ? now + m.ammo.reload * 1000 : 0;
      gun.weapon = gunKey();
      if (!m.ammo.combo) gun.combo = 0;
    }
    gun.airReadyAt = now + m.ammo.airIn * 1000;
    gun.molReadyAt = now + m.ammo.molIn * 1000;
    gun.ultReadyAt = now + m.ammo.ultIn * 1000;
    gun.squadReadyAt = now + m.ammo.squadIn * 1000;
    gun.ally = m.ammo.ally;
    if (!gun.ally && aiming === 'order') aiming = null;
    siege = { n: m.n, phase: m.phase, nextIn: m.nextIn, sides: m.sides, hq: m.hq, at: now, incoming: m.incoming, tutorial: m.tutorial, guided: m.guided, early: m.early, earlyOpensIn: m.earlyOpensIn, defence: m.defence, next: m.next, horde: m.horde, surges: m.surges };
    view.pressure = { sides: m.sides, at: now };
    view.myToughness = m.toughness;
    // Incoming-side hints are part of guidance: shown for the whole countdown, and only while guided.
    view.incoming = m.phase !== 'surge' && m.guided ? m.incoming : [];
    renderThreat();
  });
  s.on('tap', (m: TapMessage) => {
    if (!player || m.p !== player.plot) return;
    const now = performance.now();
    if (m.mag !== undefined) {
      gun.mag = m.mag;
      gun.reloadEnd = m.reload ? now + m.reload * 1000 : 0;
    }
    if (!m.ok) return;
    const before = gun.mult;
    gun.combo = m.combo;
    gun.mult = m.mult;
    if (m.kills) sfx.kill(m.mult);
    renderCombo(m.mult > before);
    if (coachStep === 1 && (coachKills += m.kills) >= 3) coach(2);
  });
  s.on('feed', (f: FeedItem) => addFeed(f));
  s.on('status', (st: { paused: boolean; frozen: boolean }) => {
    if (st.paused && !org.paused) toast('The organisers paused the game. Hang tight!', '', 5000);
    org = st;
    if (panel === 'ranks') renderPanel();
  });
  s.on('crate', (c: CrateView | null) => setCrate(c, false));
}

/** Area of interest: tell the server which bases this screen can see. */
function updateWatch() {
  if (!player || !net.socket.connected) return;
  const want: number[] = [];
  if (myRaid) want.push(myRaid.plot);
  if (focusPlot >= 0 && view.zoom >= 2 && view.plotsOfInterest(64).includes(focusPlot)) want.push(focusPlot);
  for (const p of view.plotsOfInterest(WATCH_MAX + 2)) if (!want.includes(p) && p !== player.plot) want.push(p);
  const list = want.filter((p) => p !== player!.plot).slice(0, WATCH_MAX);
  const key = list.join(',');
  if (key === watchKey) return;
  watchKey = key;
  net.watch(list);
  for (const plot of [...view.live.keys()]) if (plot !== player.plot && !list.includes(plot)) view.dropLive(plot);
}

// ---- input --------------------------------------------------------------------------------------

function bindInput() {
  // Map input: drag pans (with momentum on release), two fingers pinch-zoom around their centre,
  // the wheel zooms toward the cursor. Movement is applied straight to the camera; the animation
  // frame draws it, so nothing here waits on rendering.
  const canvas = view.canvas;
  const pointers = new Map<number, { x: number; y: number }>();
  /** Where the current one-finger gesture started, and whether it has become a drag. */
  let start = { x: 0, y: 0 };
  let dragging = false;
  let pinched = false;
  let pinch = { d0: 1, k0: 1 };
  /** Recent drag positions, for the release velocity. */
  let trail: { x: number; y: number; t: number }[] = [];
  const DRAG_START = 8;
  let pressedAt = 0;
  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.max(1, Math.hypot(a!.x - b!.x, a!.y - b!.y)), x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    view.stopFling();
    const pos = local(e);
    pointers.set(e.pointerId, pos);
    if (pointers.size === 1) {
      start = pos;
      pressedAt = e.timeStamp;
      dragging = false;
      pinched = false;
      trail = [{ ...pos, t: e.timeStamp }];
      // A press on your squad member starts dragging them, not the map.
      const ally = player && gun.ally > 0 ? view.squadAt(player.plot) : null;
      const [wx, wy] = view.toWorld(pos.x, pos.y);
      squadDrag = !!ally && Math.hypot(ally.x - wx, ally.y - 8 - wy) < 14;
    } else if (pointers.size === 2) {
      pinched = true;
      pinch = { d0: spread().d, k0: view.cam.k };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = local(e);
    if (pointers.size === 1 && squadDrag) {
      const [wx, wy] = view.toWorld(cur.x, cur.y);
      if (player) view.squadFlag = { plot: player.plot, x: wx, y: wy, at: performance.now() };
      pointers.set(e.pointerId, cur);
      return;
    }
    if (pointers.size === 1) {
      if (!dragging && Math.hypot(cur.x - start.x, cur.y - start.y) > DRAG_START) {
        // Became a drag: catch up the distance moved so far, so the map stays under the finger.
        dragging = true;
        canvas.classList.add('dragging');
        view.panBy(cur.x - start.x, cur.y - start.y);
      } else if (dragging) {
        view.panBy(cur.x - prev.x, cur.y - prev.y);
      }
      trail.push({ ...cur, t: e.timeStamp });
      while (trail.length > 2 && e.timeStamp - trail[0]!.t > 100) trail.shift();
      pointers.set(e.pointerId, cur);
    } else if (pointers.size === 2) {
      const before = spread();
      pointers.set(e.pointerId, cur);
      const after = spread();
      view.panBy(after.x - before.x, after.y - before.y);
      view.zoomFree(pinch.k0 * (after.d / pinch.d0), after.x, after.y);
    }
  });
  const up = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const pos = local(e);
    const wasTap = pointers.size === 1 && !pinched && !dragging;
    const wasDrag = pointers.size === 1 && dragging;
    pointers.delete(e.pointerId);
    if (squadDrag) {
      squadDrag = false;
      // Dragged off them: send them there. A plain tap on them falls through to a normal tap.
      if (e.type === 'pointerup' && Math.hypot(pos.x - start.x, pos.y - start.y) > DRAG_START) {
        const [wx, wy] = view.toWorld(pos.x, pos.y);
        orderSquad(wx, wy);
        return;
      }
    }
    if (pointers.size === 1) {
      // One finger of a pinch lifted: settle the zoom, the other finger keeps panning.
      view.settleZoom();
      const [rest] = [...pointers.values()];
      start = rest!;
      dragging = true;
      trail = [];
    }
    if (pointers.size === 0) {
      canvas.classList.remove('dragging');
      view.settleZoom();
    }
    if (wasDrag && e.type === 'pointerup' && trail.length >= 2) {
      const a = trail[0]!;
      const b = trail[trail.length - 1]!;
      const dt = Math.max(1, b.t - a.t);
      // Only fling if the finger was still moving when it lifted.
      if (e.timeStamp - b.t < 50) view.fling((b.x - a.x) / dt, (b.y - a.y) / dt);
    }
    if (wasTap && e.type === 'pointerup') void tap(pos.x, pos.y, e.timeStamp - pressedAt);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  let wheelAcc = 0;
  let wheelSettle = 0;
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { x, y } = local(e);
      if (e.ctrlKey) {
        // Trackpad pinch (browsers report it as ctrl+wheel): follow it smoothly, settle when it stops.
        view.zoomFree(view.cam.k * Math.exp(-e.deltaY * 0.01), x, y);
        clearTimeout(wheelSettle);
        wheelSettle = window.setTimeout(() => view.settleZoom(), 150);
        return;
      }
      // Mouse wheel / two-finger scroll: one zoom level per notch (or ~60 px of scrolling).
      wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (Math.abs(wheelAcc) >= 60) {
        view.zoomAt(wheelAcc < 0 ? 1 : -1, x, y);
        wheelAcc = 0;
      }
    },
    { passive: false },
  );

  const centre = () => [view.canvas.clientWidth / 2, view.canvas.clientHeight / 2] as const;
  $('zoom-in').addEventListener('click', () => view.zoomAt(1, ...centre()));
  $('zoom-out').addEventListener('click', () => view.zoomAt(-1, ...centre()));
  $('home-btn').addEventListener('click', () => {
    if (!player) return;
    view.centerOnPlot(player.plot, Math.max(view.zoom, view.baseZoom()));
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
    if (player) view.centerOnPlot(player.plot, Math.max(view.zoom, view.baseZoom()));
  });

  $('menu-btn').addEventListener('click', () => ($('menu').hidden = !$('menu').hidden));
  $('ammo').addEventListener('click', () => reloadGun());
  $('early-btn').addEventListener('click', () => void callEarly());
  $('mode-toggle').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
    if (btn) void switchMode(btn.dataset.mode as 'pve' | 'pvp');
  });
  $('pause-btn').addEventListener('click', () => void togglePause());
  $('strike-btn').addEventListener('click', () => toggleAim('airstrike'));
  $('molotov-btn').addEventListener('click', () => toggleAim('molotov'));
  $('squad-btn').addEventListener('click', () => void squadButton());
  $('ult-btn').addEventListener('click', () => void callUltimate());
  window.addEventListener('keydown', (e) => {
    if (!player || (e.target as HTMLElement).closest('input, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'p' && !e.repeat) return void togglePause();
    if (!$('cmd-bar').offsetParent) return;
    if (k === 'r') reloadGun();
    else if (k === 'q') toggleAim('airstrike');
    else if (k === 'e') toggleAim('molotov');
    else if (k === 'f') void squadButton();
    else if (k === 'x') void callUltimate();
    else if (e.key === 'Escape' && aiming) aiming = null;
  });
  // Sound: the same switch as the title screen's. Browsers only allow audio after a tap or key press.
  const soundIcon = () => {
    $('sound-btn').textContent = sfx.muted ? '🔇' : '🔊';
    $('sound-btn').setAttribute('aria-label', sfx.muted ? 'Sound off' : 'Sound on');
  };
  soundIcon();
  $('sound-btn').addEventListener('click', () => {
    sfx.unlock();
    sfx.toggle();
    soundIcon();
  });
  for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => sfx.unlock(), { passive: true });
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

/** Your own base's siege is on and in reach of this world point (px): taps there are shots. */
function canShoot(wx: number, wy: number): boolean {
  if (!player || myRaid || org.paused) return false;
  const l = view.live.get(player.plot);
  const p = world.plots[player.plot]!;
  if (l?.phase !== 'wave' || !inTapReach(p, wx / 16, wy / 16)) return false;
  // On a neighbour's plot a tap opens their base, unless one of your zombies is right there.
  return !inOtherPlot(p, wx / 16, wy / 16) || view.zombiesNear(player.plot, wx, wy, CMD.hitRadius * 16).length > 0;
}

/** Longest press that still counts as a shot (a longer hold is a look, not a trigger pull). */
const SHOT_PRESS_MS = 450;

async function tap(cssX: number, cssY: number, pressMs = 0) {
  if (!player) return;
  const [wx, wy] = view.toWorld(cssX, cssY);
  if (canShoot(wx, wy)) {
    if (aiming) return void useAim(wx, wy);
    // A zombie under your thumb: shoot it. Otherwise a tap on the Main Tower, a slot or a wall opens its
    // card as before, and anything else (open ground, the street) is a shot toward that point.
    const zombie = view.zombiesNear(player.plot, wx, wy, CMD.hitRadius * 16).length > 0;
    const p = world.plots[player.plot]!;
    const pick = !zombie && wx >= p.x * 16 && wy >= p.y * 16 && wx < (p.x + PLOT) * 16 && wy < (p.y + PLOT) * 16 ? view.pickInBase(p, wx, wy) : null;
    if (!pick) {
      if (pressMs <= SHOT_PRESS_MS) fireAt(wx, wy);
      return;
    }
  } else if (aiming) {
    aiming = null;
    toast('Use it on your own base', '', 2000);
    return;
  }
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
    if (view.zoom < view.baseZoom()) view.centerOnPlot(p.id, view.baseZoom());
    view.selectedPick = view.pickInBase(p, wx, wy);
    openPanel('mine', p.id);
  } else openPanel('other', p.id);
}

// ---- the Commander ---------------------------------------------------------------------------------------

function weaponName(): 'pistol' | 'gun' | 'shotgun' {
  return COMMANDER_WEAPONS[player?.base.cmd ?? 0] ?? 'pistol';
}

/** The weapon and its level as one number: a change means a fresh magazine. */
function gunKey(): number {
  return player ? (player.base.cmd ?? 0) * 10 + weaponLevel(player.base) : -1;
}

/** Shoot at a world point (px): predicted here at once, resolved by the server. */
function fireAt(wx: number, wy: number) {
  if (!player) return;
  const now = performance.now();
  const name = weaponName();
  const w = commanderWeapon(player.base);
  if (gun.weapon !== gunKey()) {
    gun.weapon = gunKey();
    gun.mag = w.magazine;
    gun.reloadEnd = 0;
  }
  if (gun.reloadEnd && now >= gun.reloadEnd) {
    gun.mag = w.magazine;
    gun.reloadEnd = 0;
  }
  if (gun.reloadEnd) {
    sfx.dry();
    const a = $('ammo');
    a.classList.remove('flash');
    void a.offsetWidth;
    a.classList.add('flash');
    return;
  }
  if (now < gun.nextShot) return; // the fire rate (the server enforces it too)
  gun.nextShot = now + 1000 / w.fireRate;
  gun.mag--;
  if (gun.mag <= 0) {
    gun.mag = 0;
    gun.reloadEnd = now + w.reload * 1000;
    sfx.reloadClick();
  }
  const targets = view.zombiesNear(player.plot, wx, wy, CMD.hitRadius * 16, 1);
  const aim = targets[0] ?? { x: wx, y: wy };
  const pellets = w.pellets > 1 ? view.zombiesNear(player.plot, aim.x, aim.y, w.spread * 16, w.pellets).map((z) => [z.x, z.y] as [number, number]) : [];
  view.commanderFire(player.plot, aim.x, aim.y, now, pellets);
  sfx.shot(name);
  if (name === 'shotgun') view.shake(THEME.siege.shake.shotgun * view.dpr, 120);
  net.tap(wx / 16, wy / 16);
}

function reloadGun() {
  if (!player) return;
  const w = commanderWeapon(player.base);
  const now = performance.now();
  if (gun.reloadEnd || gun.mag >= w.magazine) return;
  gun.reloadEnd = now + w.reload * 1000;
  sfx.reloadClick();
  net.reload();
}

const POWER_NAME: Record<AbilityId, string> = { airstrike: 'Airstrike', molotov: 'Molotov', squad: 'Squad member', ultimate: 'Carpet bomb' };

/** Is this power locked, or cooling down? A toast says so (true = can't use it now). */
function powerBlocked(id: AbilityId, readyAt: number): boolean {
  if (!player) return true;
  if (!abilityUnlocked(player.base.hq, id)) {
    toast(`${POWER_NAME[id]} unlocks at Main Tower Lv ${CMD[id].unlockHq}`, '', 1800);
    return true;
  }
  const left = readyAt - performance.now();
  if (left > 0) {
    toast(`${POWER_NAME[id]} ready in ${Math.ceil(left / 1000)}s`, '', 1500);
    return true;
  }
  return false;
}

/** Arm (or cancel) a power that needs a spot on the map. */
function toggleAim(id: 'airstrike' | 'molotov') {
  if (aiming === id) {
    aiming = null;
    return;
  }
  if (powerBlocked(id, id === 'airstrike' ? gun.airReadyAt : gun.molReadyAt)) return;
  aiming = id;
  toast(id === 'airstrike' ? 'Tap the map to call the airstrike' : 'Tap the map to throw the molotov', '', 2000);
}

/** The tap that follows an armed power. */
async function useAim(wx: number, wy: number) {
  const what = aiming;
  aiming = null;
  if (what === 'order') return orderSquad(wx, wy);
  if (what === 'airstrike') {
    const r = await net.airstrike(wx / 16, wy / 16);
    if (!r.ok) return toast(r.error, 'bad', 2000);
    gun.airReadyAt = performance.now() + r.ready * 1000;
    sfx.whistle(CMD.airstrike.delay);
  } else if (what === 'molotov') {
    const r = await net.molotov(wx / 16, wy / 16);
    if (!r.ok) return toast(r.error, 'bad', 2000);
    gun.molReadyAt = performance.now() + r.ready * 1000;
    sfx.boom();
  }
}

async function callUltimate() {
  if (powerBlocked('ultimate', gun.ultReadyAt)) return;
  const r = await net.ultimate();
  if (!r.ok) return toast(r.error, 'bad', 2000);
  gun.ultReadyAt = performance.now() + r.ready * 1000;
  sfx.siren(true);
  sfx.whistle(CMD.ultimate.delay);
}

/** The squad button: summon them if they're not out, otherwise tap the map to send them. */
async function squadButton() {
  if (!player) return;
  if (gun.ally > 0) {
    aiming = aiming === 'order' ? null : 'order';
    if (aiming) toast('Tap the map to send your squad member (or drag them)', '', 2000);
    return;
  }
  if (powerBlocked('squad', gun.squadReadyAt)) return;
  const kind = raiderUnlocked(squadKind, player.base.hq) ? squadKind : 'r_bat';
  const r = await net.summon(kind);
  if (!r.ok) return toast(r.error, 'bad', 2000);
  gun.ally = 100;
  toast(`${RAIDER_NAME[kind]} joins the fight! Tap 🪖 then the map, or drag them, to move them.`, 'good', 3000);
  sfx.confirm();
}

function orderSquad(wx: number, wy: number) {
  if (!player) return;
  net.order(wx / 16, wy / 16);
  view.squadFlag = { plot: player.plot, x: wx, y: wy, at: performance.now() };
}

let comboShown = '';
function renderCombo(bump: boolean) {
  const el = $('combo');
  const text = gun.combo >= 2 ? `${gun.combo} KILLS${gun.mult > 1 ? ` · x${gun.mult} COINS` : ''}` : '';
  if (text !== comboShown) {
    comboShown = text;
    el.textContent = text;
    el.hidden = !text;
  }
  if (bump) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
}

let roundsShown = '';
/** The ammo bar, combo and airstrike button: shown while your base is under siege and on screen. */
function renderCmdBar(now: number) {
  if (!player) return;
  const l = view.live.get(player.plot);
  const p = world.plots[player.plot]!;
  const [x0, y0, x1, y1] = view.viewRect();
  const onScreen = (p.x + PLOT) * 16 > x0 && p.x * 16 < x1 && (p.y + PLOT) * 16 > y0 && p.y * 16 < y1;
  const show = l?.phase === 'wave' && !myRaid && onScreen && !org.paused;
  const bar = $('cmd-bar');
  if (bar.hidden === show) bar.hidden = !show;
  view.canvas.classList.toggle('aim', show);
  view.canvas.classList.toggle('strike-aim', show && !!aiming);
  if (!show) {
    if (aiming) aiming = null;
    return;
  }
  const name = weaponName();
  const w = commanderWeapon(player.base);
  if (gun.weapon !== gunKey()) {
    gun.weapon = gunKey();
    gun.mag = w.magazine;
    gun.reloadEnd = 0;
  }
  const reloading = gun.reloadEnd > now;
  if (gun.reloadEnd && !reloading) {
    gun.mag = w.magazine;
    gun.reloadEnd = 0;
  }
  const key = `${name}${w.level}${gun.mag}${reloading}`;
  if (key !== roundsShown) {
    roundsShown = key;
    $('ammo-name').textContent = `${WEAPON_NAME[name].toUpperCase()}${w.level > 1 ? ` LV${w.level}` : ''}`;
    $('rounds').innerHTML = Array.from({ length: w.magazine }, (_, i) => `<i${i >= gun.mag ? ' class="spent"' : ''}></i>`).join('');
    $('ammo').classList.toggle('reloading', reloading);
  }
  $('reload-fill').style.width = reloading ? `${100 * (1 - (gun.reloadEnd - now) / (w.reload * 1000))}%` : '0';
  // Power buttons: only the unlocked ones, each with its cooldown.
  const hq = player.base.hq;
  const power = (id: string, unlocked: boolean, readyAt: number, armed: boolean) => {
    const btn = $(`${id}-btn`);
    if (btn.hidden === unlocked) btn.hidden = !unlocked;
    if (!unlocked) return;
    const cd = Math.max(0, Math.ceil((readyAt - now) / 1000));
    btn.classList.toggle('cooling', cd > 0);
    btn.classList.toggle('aiming', armed);
    const cdText = cd > 0 ? String(cd) : '';
    const el = $(`${id}-cd`);
    if (el.textContent !== cdText) el.textContent = cdText;
  };
  power('strike', abilityUnlocked(hq, 'airstrike'), gun.airReadyAt, aiming === 'airstrike');
  power('molotov', abilityUnlocked(hq, 'molotov'), gun.molReadyAt, aiming === 'molotov');
  power('squad', abilityUnlocked(hq, 'squad'), gun.ally > 0 ? 0 : gun.squadReadyAt, aiming === 'order');
  power('ult', abilityUnlocked(hq, 'ultimate'), gun.ultReadyAt, false);
  const sq = $('squad-btn');
  sq.classList.toggle('out', gun.ally > 0);
  $('squad-hp').style.width = gun.ally > 0 ? `${gun.ally}%` : '0';
  // Call early: between surges; the button says when it opens and what it pays.
  const early = $<HTMLButtonElement>('early-btn');
  const between = !!siege && (siege.phase === 'breather' || siege.phase === 'start') && now - siege.at < 3000 && !siege.tutorial;
  if (early.hidden === between) early.hidden = !between;
  if (between) {
    const opens = Math.max(0, siege!.earlyOpensIn - Math.floor((now - siege!.at) / 1000));
    const sub = opens > 0 ? `in ${opens}s` : siege!.early > 0 ? `+${siege!.early} coins` : 'coming anyway';
    if ($('early-sub').textContent !== sub) $('early-sub').textContent = sub;
    early.disabled = opens > 0 || siege!.early <= 0;
  }
}

async function panelClick(e: MouseEvent) {
  const el = e.target as HTMLElement;
  if (el.closest('[data-close]')) return openPanel('none');
  const jump = el.closest<HTMLElement>('[data-jump]');
  if (jump) return jumpTo(Number(jump.dataset.jump));
  if (el.closest('[data-crate-jump]')) {
    view.jumpTo(CRATE_SPOT.x, CRATE_SPOT.y, Math.max(view.zoom, 2));
    return;
  }
  const pick = el.closest<HTMLButtonElement>('button[data-squad]');
  if (pick && !pick.disabled) {
    squadKind = pick.dataset.squad as RaiderKind;
    try {
      localStorage.setItem('siege.squad', squadKind);
    } catch {
      /* private mode */
    }
    renderPanel();
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
    view.centerOnPlot(plot, Math.max(view.zoom, view.baseZoom()));
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
    if (action.kind === 'hq') {
      const fresh = powersUnlockedAt(r.player.base.hq);
      if (fresh.length) showUnlocked(fresh);
    }
  } else {
    toast(r.error, 'bad');
    renderPanel();
  }
}

/** Fly to a base from a list and open its card. */
function jumpTo(plot: number) {
  view.centerOnPlot(plot, Math.max(view.zoom, view.baseZoom()));
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
    view.centerOnPlot(r.plot, Math.max(view.zoom, view.baseZoom()));
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
  // One canvas pixel per world tile.
  mini.width = world.w;
  mini.height = world.h;
  let down = false;
  const go = (e: PointerEvent) => {
    const r = mini.getBoundingClientRect();
    view.jumpTo(((e.clientX - r.left) / r.width) * world.w * 16, ((e.clientY - r.top) / r.height) * world.h * 16);
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
    const M = THEME.minimap;
    const colors = [M.ground, M.street, M.mud, M.alley];
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
      g.fillStyle = THEME.minimap.empty;
      g.fillRect(p.x + 2, p.y + 2, PLOT - 4, PLOT - 4);
      continue;
    }
    g.fillStyle = s.raid && pulse ? THEME.tag.raid : baseColor(s.id);
    if (player && p.id === player.plot) {
      g.fillStyle = THEME.mine;
      g.fillRect(p.x + 1, p.y + 1, PLOT - 2, PLOT - 2);
      g.fillStyle = baseColor(s.id);
    }
    g.fillRect(p.x + 2, p.y + 2, PLOT - 4, PLOT - 4);
  }
  for (const gy of world.graveyards) {
    const w = Math.max(0, ...gy.serves.map((id) => view.bases.get(id)?.wave ?? 0));
    g.fillStyle = w === 2 ? (pulse ? `rgb(${THEME.graveWave.join(',')})` : THEME.minimap.waveDim) : w === 1 ? `rgb(${THEME.graveWarn.join(',')})` : `rgb(${THEME.minimap.mud.join(',')})`;
    g.fillRect(gy.x, gy.y, gy.w, gy.h);
  }
  if (view.crate) {
    g.fillStyle = pulse ? THEME.minimap.flash : `rgb(${THEME.crate[view.crate.rarity]})`;
    g.fillRect(Math.round(CRATE_SPOT.x / 16) - 3, Math.round(CRATE_SPOT.y / 16) - 3, 6, 6);
  }
  const [x0, y0, x1, y1] = view.viewRect();
  g.strokeStyle = THEME.minimap.view;
  g.lineWidth = 1;
  g.strokeRect(Math.round(x0 / 16) + 0.5, Math.round(y0 / 16) + 0.5, Math.round((x1 - x0) / 16) - 1, Math.round((y1 - y0) / 16) - 1);
}

// ---- rendering ----------------------------------------------------------------------------------

function setPlayer(p: PlayerView) {
  player = p;
  view.myPlot = p.plot;
  view.myBase = p.base;
  view.onHqHurt = hurt;
  renderHud();
  renderChips();
  renderModeToggle();
  renderObjectives();
  if (panel === 'mine' || panel === 'other') renderPanel();
  renderAttackBar();
}

/** Small status chips under the name: immunity/shield and active boosts. */
// ---- the walkthrough --------------------------------------------------------------------------------------

const COACH = [
  '',
  'Tap the zombies to shoot them!',
  'Nice shooting! Keep tapping, your posts help too.',
  'Held! Now buy a post: tap a glowing + slot in your base.',
  "You're ready. Watch the arrows: they show where the next surge comes from.",
];

/** Show walkthrough prompt `step` (0 hides it). */
function coach(step: number) {
  coachStep = step;
  coachAt = performance.now();
  if (step === 1) coachKills = 0;
  if (step === 3) coachPosts = player?.base.posts.filter(Boolean).length ?? 0;
  const el = $('coach');
  el.textContent = COACH[step] ?? '';
  el.hidden = !step;
}

/** Move the walkthrough along: a post bought, or prompts that have been up long enough. */
function tickCoach(now: number) {
  if (!coachStep || !player) return;
  const up = now - coachAt;
  if (coachStep === 2 && up > 6000) coach(siege?.phase === 'surge' ? 2 : 3);
  else if (coachStep === 3 && (player.base.posts.filter(Boolean).length > coachPosts || up > 30_000)) coach(4);
  else if (coachStep === 4 && up > 7000) coach(0);
}

async function callEarly() {
  const r = await net.callEarly();
  if (!r.ok) return toast(r.error, '', 2000);
  flash = { text: `⏩ Called early: +${r.bonus} coins!`, cls: 'held', until: performance.now() + 1800 };
  sfx.confirm();
}

/** Grind or Raid: the server checks the cooldown and the locks (a surge, a raid either way). */
async function switchMode(mode: 'pve' | 'pvp') {
  if (!player || player.mode === mode) return;
  const r = await net.setMode(mode);
  if (!r.ok) return toast(r.error, 'bad', 2500);
  setPlayer(r.player);
  toast(mode === 'pvp' ? 'Raid mode: the swarms hold off. Pick a rival base and attack!' : 'Grind mode: the swarms are coming. Fill your vault!', 'good', 3500);
}

/** The toggle's state and the cooldown under it. */
function renderModeToggle() {
  if (!player) return;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-toggle button')) b.setAttribute('aria-pressed', String(b.dataset.mode === player.mode));
  const left = Math.ceil((player.modeAt + CONFIG.modes.cooldown * 1000 - serverNow()) / 1000);
  const text = left > 0 ? `switch in ${left}s` : '';
  if ($('mode-cd').textContent !== text) $('mode-cd').textContent = text;
}

/** The threat meter: green while your defence covers the next surge, amber when it's close, red when it's ahead of you. */
function renderThreat() {
  if (!siege) return;
  $('threat-def').textContent = String(siege.defence);
  $('threat-next').textContent = String(siege.next);
  const r = siege.next / Math.max(1, siege.defence);
  const cls = r <= 1 ? 'safe' : r <= 1.25 ? 'close' : 'danger';
  const el = $('threat');
  if (!el.classList.contains(cls)) {
    el.classList.remove('safe', 'close', 'danger');
    el.classList.add(cls);
  }
  const word = (siege.horde && siege.phase !== 'surge' ? 'HORDE NEXT · ' : '') + (cls === 'safe' ? 'READY' : cls === 'close' ? 'UPGRADE SOON' : 'UPGRADE!');
  if ($('threat-word').textContent !== word) $('threat-word').textContent = word;
}

/** The basic-base checklist, while guidance lasts; "Base ready!" the moment it's done. */
function renderObjectives() {
  if (!player) return;
  const done = basicBaseDone(player.base);
  if (wasGuided && done) {
    flash = { text: '🏰 Base ready! No more training wheels: every surge gets tougher now.', cls: 'held', until: performance.now() + 4500 };
    sfx.confirm();
    view.shake(2 * view.dpr, 300);
    coach(0);
  }
  wasGuided = !done;
  const el = $('objectives');
  if (el.hidden !== done) el.hidden = done;
  if (done) return;
  const html = BASIC_BASE.map((i) => `<li class="${i.done(player!.base) ? 'done' : ''}">${esc(i.label)}</li>`).join('');
  if ($('objectives-list').innerHTML !== html) $('objectives-list').innerHTML = html;
}

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

const SIDE_LABEL = ['north', 'east', 'south', 'west'];

function renderBanner(now: number) {
  if (!player) return;
  const l = view.live.get(player.plot);
  const b = $('wave-banner');
  let text = 'All quiet.';
  let cls = '';
  if (org.paused) {
    text = '⏸ Game paused by the organisers';
  } else if (l?.phase === 'raid') {
    text = `⚔ ${l.raid?.attacker ?? 'Someone'} is raiding your base! (${l.raid?.destruction ?? 0}% destroyed)`;
    cls = 'attack';
  } else if (player.mode === 'pvp') {
    text = myRaid ? `⚔ Raiding ${myRaid.defender}` : '⚔ Raid mode: the swarms hold off. Tap a rival base and attack!';
    cls = 'attack';
  } else if (player.pause?.state === 'paused') {
    text = `⏸ PAUSED · surges resume on their own in ${clockText(player.pause.until - serverNow())}`;
    cls = 'paused';
  } else if (siege && siege.phase === 'resuming' && now - siege.at < 3000) {
    const left = Math.max(1, siege.nextIn - Math.floor((now - siege.at) / 1000));
    text = `▶ Surges resume in ${left}...`;
    cls = 'alarm';
  } else if (flash && now < flash.until) {
    text = flash.text;
    cls = flash.cls;
  } else if (siege && now - siege.at < 3000) {
    let zombies = 0;
    if (l) for (const u of l.units.values()) if (u.state !== 2) zombies++;
    const from = siege.incoming.map((i) => SIDE_LABEL[i] ?? 'graveyard');
    const fromText = from.length >= 5 ? 'every side' : from.length > 1 ? `${from.slice(0, -1).join(', ')} and ${from.at(-1)}` : from[0];
    // Where it comes from is a guidance hint; afterwards you find out when it hits.
    const fromPart = siege.guided ? ` · from the ${fromText}` : '';
    if (siege.phase === 'surge') {
      text = `☠ Surge ${siege.n} is on: ${zombies} zombie${zombies === 1 ? '' : 's'} on the field`;
      cls = 'attack';
    } else {
      // A regular countdown to the next surge, and where it comes from.
      const left = Math.max(0, siege.nextIn - Math.floor((now - siege.at) / 1000));
      text = `${siege.n === 0 && siege.tutorial ? 'First zombies' : `Surge ${siege.n + 1}`} in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}${fromPart}`;
      cls = left <= 5 ? 'attack' : '';
    }
  }
  if (b.textContent !== text) b.textContent = text;
  if (b.dataset.cls !== cls) {
    b.dataset.cls = cls;
    b.classList.toggle('attack', cls === 'attack');
    b.classList.toggle('alarm', cls === 'alarm');
    b.classList.toggle('held', cls === 'held');
    b.classList.toggle('paused', cls === 'paused');
  }
  renderPauseButton(now);
}

/** m:ss for a duration in ms (never negative). */
function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let pauseShown = '';
/** The Pause/Resume button: Grind mode only, from surge 2, with the pause's time left or the cooldown. */
function renderPauseButton(now: number) {
  if (!player) return;
  const btn = $<HTMLButtonElement>('pause-btn');
  const show = player.mode === 'pve' && !myRaid && !org.paused;
  let text = '';
  let state = '';
  let disabled = false;
  if (show) {
    const p = player.pause;
    const cooldown = player.pauseCooldownUntil - serverNow();
    const firstSurge = !siege || siege.surges === 0 || siege.tutorial;
    if (p?.state === 'paused') {
      text = `▶ Surges paused · Resume ${clockText(p.until - serverNow())}`;
      state = 'paused';
    } else if (p?.state === 'pending') {
      text = '⏳ Pausing after this surge...';
      state = 'pending';
    } else if (firstSurge) {
      text = '⏸ Pause after surge 1';
      disabled = true;
    } else if (cooldown > 0) {
      text = `⏸ Pause in ${clockText(cooldown)}`;
      disabled = true;
    } else text = '⏸ Pause surges';
  }
  void now;
  const key = `${show}|${text}|${state}|${disabled}`;
  if (key === pauseShown) return;
  pauseShown = key;
  btn.hidden = !show;
  btn.textContent = text;
  btn.disabled = disabled;
  btn.dataset.state = state;
  btn.title = state === 'pending' ? 'Tap to cancel the pause' : state === 'paused' ? 'Tap (or P) to resume' : 'Pause surges (P)';
}

/** P or the button: pause, cancel a pending pause, or resume. */
async function togglePause() {
  if (!player || player.mode !== 'pve') return;
  const r = player.pause ? await net.resume() : await net.pause();
  if (!r.ok) return toast(r.error, 'bad', 2500);
  const was = player.pause;
  setPlayer(r.player);
  const p = r.player.pause;
  if (p?.state === 'paused') toast('Surges paused. Upgrade, buy and shoot freely; no zombie income while paused.', 'good', 3500);
  else if (p?.state === 'pending') toast('Pausing as soon as this surge is over', '', 2500);
  else if (was?.state === 'pending') toast('Pause cancelled', '', 2000);
  else {
    toast('Surges resume in 3...', 'good', 2000);
    sfx.siren(false);
  }
}


/** ★★☆ for a star count. */
function starText(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(Math.max(0, 3 - n));
}

function renderAttackBar() {
  if (!myRaid || !player) return;
  $('raid-title').textContent = `Raiding ${myRaid.defender}${myRaid.vault ? ' · vault cracked!' : ''}`;
  $('raid-stars').textContent = starText(myRaid.stars);
  $('raid-dmg').textContent = `${myRaid.destruction}%`;
  $('raid-army').textContent = String(myRaid.armyLeft);
  const html = RAIDER_KINDS.map((k) => {
    const c = CONFIG.pvp.raiders[k];
    const locked = !raiderUnlocked(k, player!.base.hq);
    const cost = raiderCost(k, player!.base.hq);
    const poor = player!.coins < cost;
    const sub = locked ? `Main Tower Lv ${c.unlockHq}` : `${cost} coins`;
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
  else if (player!.mode !== 'pvp') why = 'Switch to Raid mode to attack';
  else if (s.raid) why = 'Already under attack';
  else if (immune) why = 'Bought immunity from raids';
  else if (shielded) why = 'Shielded for a while after a raid';
  const win = trophyStake(player!.trophies, s.trophies);
  const posts = s.posts.filter(Boolean).length;
  return `${head(esc(s.name))}<p class="sub">${status}</p>${stats([
    ['Main Tower', `Lv ${s.hq}`],
    ['Trophies', s.trophies],
    ['Loot', `up to ~${s.loot}`],
    ['Walls', `Lv ${s.walls}`],
    ['Posts', posts],
    ['Win', `up to +${win} ♛ (3★)`],
  ])}<div class="actions"><button class="btn" data-attack="${s.p}" ${why ? 'disabled' : ''}>Attack<small>${why ? esc(why) : 'Raiders cost coins to send'}</small></button><button class="btn secondary" data-spectate="${s.p}">Spectate<small>Watch this base</small></button></div>`;
}

function modeChip(mode: string): string {
  return mode === 'pvp' ? '<span class="mode-chip pvp">Raiding</span>' : '<span class="mode-chip pve">Grinding</span>';
}

function ranksPanel(): string {
  const list = [...view.bases.values()].sort((a, b) => b.trophies - a.trophies || b.hq - a.hq).slice(0, 50);
  const rows = list
    .map((b, i) => `<li><button data-jump="${b.p}" class="${player && b.id === player.id ? 'me' : ''}"><span class="rank">#${i + 1}</span><span class="nm">${esc(b.name)} <small>Lv${b.hq}</small>${modeChip(b.mode)}</span><span class="val">♛ ${b.trophies}</span></button></li>`)
    .join('');
  return `${head('Leaderboard')}<p class="sub">${org.frozen ? '<span class="status shield">Frozen by the organisers</span> ' : ''}Trophies come only from raids. Tap a name to fly to their base.</p><ul class="list">${rows || '<li class="empty">No one yet.</li>'}</ul>`;
}

function livePanel(): string {
  const list = [...view.bases.values()].filter((b) => b.raid);
  const rows = list
    .map((b) => {
      const l = view.live.get(b.p)?.raid;
      const extra = l ? `${starText(l.stars)} ${l.destruction}%` : 'live';
      return `<li><button data-jump="${b.p}"><span class="nm">${esc(b.raider ?? '?')} ⚔ ${esc(b.name)}</span><span class="val">${extra}</span></button></li>`;
    })
    .join('');
  return `${head('Live battles')}<p class="sub">Tap a battle to watch it.</p><ul class="list">${rows || '<li class="empty">No raids right now.</li>'}</ul><p class="note"><a href="/siege/arena/" target="_blank" rel="noopener">Open the Live Arena</a> to watch battles on any screen.</p>`;
}

function minePanel(): string {
  const base = player!.base;
  const sel = view.selectedPick;
  const l = view.live.get(player!.plot);
  const waveNote = l?.phase === 'raid' ? '<p class="note">A raid is on: changes join the next fight.</p>' : '';
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
      for (const pw of powersUnlockedAt(next)) unlocks.push(`${pw.icon} ${pw.name}`);
      unlocks.push(`posts & walls up to Lv ${next}`);
    }
    return `${head(`Main Tower · Lv ${base.hq}`)}<p class="sub">The heart of your base. If zombies destroy it you lose some coins; raiders who destroy it win. Its level caps everything else.</p>${stats([
      ['Health', CONFIG.hq.hp(base.hq)],
      ['Post slots', `${slotsUnlocked(base.hq)}/8`],
      ['Next level', next <= CONFIG.hq.maxLevel ? unlocks.join(', ') : 'Max'],
    ])}<div class="actions">${button(`Upgrade to Lv ${next}`, { kind: 'hq' })}</div>${commanderCard(base)}${waveNote}`;
  }
  if (sel.kind === 'walls') {
    const kind = base.walls >= CONFIG.walls.reinforcedFromLevel ? 'Reinforced' : 'Wooden';
    const nextKind = base.walls + 1 >= CONFIG.walls.reinforcedFromLevel ? 'reinforced' : 'wooden';
    return `${head(`Walls · Lv ${base.walls}`)}<p class="sub">${kind} walls ring your base. Axe zombies and brutes hit them hard.</p>${stats([
      ['Health each', CONFIG.walls.hp(base.walls)],
      ['Next level', base.walls < CONFIG.walls.maxLevel ? `${CONFIG.walls.hp(base.walls + 1)} (${nextKind})` : 'Max'],
    ])}<div class="actions">${button(`Upgrade to Lv ${base.walls + 1}`, { kind: 'walls' })}</div>${waveNote}`;
  }
  if (sel.kind === 'vault') {
    const f = Math.round(100 * CONFIG.pvp.loot.fromVault);
    return `${head('Vault')}<p class="sub">Your coins sit here. Raiders who crack it take ${f}% of the loot they could steal; the rest depends on how much of your base they destroy. It grows tougher with your Main Tower. Keep posts close to it.</p>${stats([
      ['Health', CONFIG.vault.hp(base.hq)],
      ['Loot at stake now', `up to ${lootable(player!.coins, base.hq)} coins`],
    ])}${waveNote}`;
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

/** The Commander's weapon and what the next one gives (on the Main Tower card). */
function commanderCard(base: BaseState): string {
  const cur = COMMANDER_WEAPONS[base.cmd ?? 0] ?? 'pistol';
  const nextName = COMMANDER_WEAPONS[(base.cmd ?? 0) + 1];
  const lv = weaponLevel(base);
  const max = CMD.weaponLevels.max;
  const line = (x: ReturnType<typeof weaponStats>) => `${x.pellets > 1 ? `${x.pellets} x ${x.damage}` : x.damage} dmg · ${x.fireRate}/s · ${x.magazine} rounds · ${x.reload}s reload`;
  const up = lv < max ? weaponStats(cur, lv + 1) : null;
  const actions = [
    up ? button(`Upgrade ${WEAPON_NAME[cur]} to Lv ${lv + 1}`, { kind: 'cmdUp' }) : '',
    nextName ? button(`Arm with ${WEAPON_NAME[nextName]}`, { kind: 'commander' }) : '',
  ].join('');
  // Every power, unlocked or not: locked ones greyed out with the level that opens them.
  const powers = POWERS.map((pw) => {
    const locked = base.hq < pw.unlockHq;
    const tag = locked ? `🔒 Lv ${pw.unlockHq}` : pw.kind === 'weapon' ? ((base.cmd ?? 0) >= COMMANDER_WEAPONS.indexOf(pw.id as (typeof COMMANDER_WEAPONS)[number]) ? 'Armed' : 'Buy above') : 'Ready';
    return `<li class="power${locked ? ' locked' : ''}"><span class="power-icon">${pw.icon}</span><span><b>${esc(pw.name)}</b><small>${esc(pw.desc)}</small></span><em>${tag}</em></li>`;
  }).join('');
  const squad = abilityUnlocked(base.hq, 'squad')
    ? `<p class="sub">Squad member: pick who answers your call (your raider roster).</p><div class="squad-pick">${RAIDER_KINDS.map((k) => `<button class="troop ${k === squadKind ? 'on' : ''}" data-squad="${k}" ${raiderUnlocked(k, base.hq) ? '' : 'disabled'}>${RAIDER_NAME[k]}</button>`).join('')}</div>`
    : '';
  return `<h3>Commander</h3><p class="sub">Tap zombies around your base to shoot them yourself. Kills in a row build a coin combo.</p>${stats([
    ['Weapon', `${WEAPON_NAME[cur]} Lv ${lv}/${max}: ${line(weaponStats(cur, lv))}`],
    ...(up ? [['Lv ' + (lv + 1), line(up)] as [string, string]] : []),
    ...(nextName ? [['Next weapon', `${WEAPON_NAME[nextName]}: ${line(weaponStats(nextName, 1))}`] as [string, string]] : []),
  ])}${actions ? `<div class="actions">${actions}</div>` : ''}<h3>Powers</h3><ul class="powers-list">${powers}</ul>${squad}`;
}

/** The "New power unlocked!" moment after a Main Tower upgrade. */
function showUnlocked(list: PowerInfo[]) {
  const el = $('unlock');
  el.innerHTML = `<div class="unlock-card"><p class="unlock-title">New power unlocked!</p>${list.map((p) => `<div class="unlock-item"><span class="unlock-icon">${p.icon}</span><span><b>${esc(p.name)}</b><small>${esc(p.desc)}</small></span></div>`).join('')}<p class="unlock-tap">Tap to continue</p></div>`;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  sfx.held();
  const hide = () => {
    el.hidden = true;
    el.removeEventListener('click', hide);
  };
  el.addEventListener('click', hide);
  setTimeout(hide, 5000);
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
    case 'commander':
      return `Commander armed with a ${WEAPON_NAME[weaponName()]}!`;
    case 'cmdUp':
      return `${WEAPON_NAME[weaponName()]} upgraded to Lv ${player ? weaponLevel(player.base) : ''}!`;
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
