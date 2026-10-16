import { Sfx, arrow, chunkyFrame, pixelText, tinyText, tinyWidth, wrap } from './retro.ts';
import { themeNum, themeVar } from './theme.ts';
import { AttractScene, loadTitleArt } from './titleScene.ts';

// The arcade title screen: one pixel-perfect canvas at a low internal resolution (320x180 landscape,
// 180x320 portrait), scaled up by whole numbers and letterboxed. Attract-mode battle, fire logo, live
// top-3 score row, an arrow menu, a retro login (real hidden inputs for keyboards, paste and screen
// readers) and a how-to-play screen. Keyboard, mouse and touch; WebAudio blips; CRT toggle.

export interface TitleOptions {
  /** Log in with name + roll number (the game's normal rules apply). */
  login(name: string, roll: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Public live stats: { top: {name, trophies}[], online }. */
  summaryUrl: string;
}

interface Summary {
  top: { name: string; trophies: number }[];
  online: number;
}

type Screen = 'menu' | 'login' | 'help';
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MENU = ['START GAME', 'HOW TO PLAY', 'LEADERBOARD', 'LIVE ARENA'];
const LOGIN_ITEMS = ['START', 'BACK'];
const HELP = [
  'BUILD: TAP YOUR MAIN TOWER, WALLS OR POST SLOTS TO UPGRADE THEM.',
  'ZOMBIES RISE FROM YOUR GRAVEYARD. EVERY KILL PAYS COINS.',
  'RAID: TAP A RIVAL BASE, ATTACK, THEN DROP RAIDERS ON THE RED GROUND.',
  'CRATES DROP WITH A CODE QUESTION. FIRST CORRECT ANSWER WINS A BOOST.',
  'BUY IMMUNITY TO KEEP RAIDERS AWAY FOR A WHILE.',
  'ONE BASE PER ROLL NUMBER. COME BACK ANY TIME WITH THE SAME NAME.',
];

export class TitleScreen {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private W = 320;
  private H = 180;
  private portrait = false;
  private scene: AttractScene | null = null;
  private screen: Screen = 'menu';
  private sel = 0;
  /** Login: 0 name field, 1 roll field, 2 START, 3 BACK. */
  private focus = 0;
  private message: { text: string; bad: boolean } | null = null;
  private busy = false;
  private summary: Summary | null = null;
  private offline = false;
  private visible = false;
  private raf = 0;
  private last = 0;
  private time = 0;
  private glitchUntil = 0;
  private nextGlitch = 4;
  private logo: HTMLCanvasElement | null = null;
  private poll = 0;
  private sfx = new Sfx('siege.title.muted');
  private crt = true;
  private hits: { rect: Rect; act: () => void; hover?: () => void }[] = [];
  private nameInput: HTMLInputElement;
  private rollInput: HTMLInputElement;
  private crtLayer: HTMLElement;
  private live: HTMLElement;

  constructor(private readonly root: HTMLElement, private readonly opts: TitleOptions) {
    this.canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
    this.g = this.canvas.getContext('2d')!;
    this.nameInput = root.querySelector<HTMLInputElement>('#title-name')!;
    this.rollInput = root.querySelector<HTMLInputElement>('#title-roll')!;
    this.crtLayer = root.querySelector<HTMLElement>('.title-crt')!;
    this.live = root.querySelector<HTMLElement>('#title-live')!;
    try {
      this.crt = localStorage.getItem('siege.title.crt') !== '0';
    } catch {
      /* private mode */
    }
    this.bind();
  }

  /** Load the art (call once, alongside the game's own loading). */
  async init() {
    this.scene = new AttractScene(await loadTitleArt());
    this.layout();
  }

  get shown() {
    return this.visible;
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
    this.toScreen('menu');
    this.layout();
    this.fetchSummary();
    this.poll = window.setInterval(() => this.fetchSummary(), 10_000);
    this.start();
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.stop();
    clearInterval(this.poll);
    this.nameInput.blur();
    this.rollInput.blur();
  }

  // ---- loop ----------------------------------------------------------------------------------------------

  private start() {
    if (this.raf || document.hidden || !this.visible) return;
    this.last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.time += dt;
      this.scene?.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // ---- layout --------------------------------------------------------------------------------------------

  /** Pick the orientation and the largest whole-number scale that fits; letterbox the rest. */
  private layout() {
    const long = themeNum('--title-res-long');
    const short = themeNum('--title-res-short');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.portrait = vh > vw;
    this.W = this.portrait ? short : long;
    this.H = this.portrait ? long : short;
    if (this.canvas.width !== this.W || this.canvas.height !== this.H) {
      this.canvas.width = this.W;
      this.canvas.height = this.H;
      this.logo = null;
    }
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.max(1, Math.floor(Math.min((vw * dpr) / this.W, (vh * dpr) / this.H)));
    const cssW = (this.W * scale) / dpr;
    const cssH = (this.H * scale) / dpr;
    Object.assign(this.canvas.style, { width: `${cssW}px`, height: `${cssH}px`, left: `${(vw - cssW) / 2}px`, top: `${(vh - cssH) / 2}px` });
    Object.assign(this.crtLayer.style, { width: `${cssW}px`, height: `${cssH}px`, left: `${(vw - cssW) / 2}px`, top: `${(vh - cssH) / 2}px` });
    this.crtLayer.hidden = !this.crt;
    const s = this.sceneRect();
    this.scene?.resize(s.w, s.h);
    this.placeInputs();
  }

  private sceneRect(): Rect {
    return this.portrait ? { x: 8, y: 120, w: 164, h: 92 } : { x: 10, y: 52, w: 300, h: 66 };
  }

  /** The login/help panel: covers the scene and menu area. */
  private panelRect(): Rect {
    if (this.portrait) return { x: 10, y: 118, w: 160, h: 153 };
    // Landscape: the login keeps the battle visible on the right; help needs the full width.
    return this.screen === 'help' ? { x: 12, y: 54, w: 296, h: 112 } : { x: 12, y: 54, w: 184, h: 112 };
  }

  private fieldRect(i: 0 | 1): Rect {
    const p = this.panelRect();
    const top = p.y + (this.portrait ? 14 : 10) + i * (this.portrait ? 36 : 30);
    return { x: p.x + 8, y: top + 11, w: p.w - 16, h: 14 };
  }

  /** Real inputs sit exactly over the drawn fields: phone keyboards, paste and screen readers just work. */
  private placeInputs() {
    const on = this.screen === 'login' && this.visible;
    for (const [i, input] of [this.nameInput, this.rollInput].entries()) {
      input.hidden = !on;
      if (!on) continue;
      const r = this.fieldRect(i as 0 | 1);
      const box = this.canvas.getBoundingClientRect();
      const k = box.width / this.W;
      Object.assign(input.style, { left: `${box.left + r.x * k}px`, top: `${box.top + r.y * k}px`, width: `${r.w * k}px`, height: `${r.h * k}px` });
    }
  }

  // ---- screens & actions ----------------------------------------------------------------------------------

  private toScreen(s: Screen) {
    this.screen = s;
    this.message = null;
    if (s === 'menu') this.say(MENU[this.sel]!);
    if (s === 'login') {
      this.focus = 0;
      this.placeInputs();
      this.nameInput.focus();
      this.say('Enter your name and roll number');
    } else {
      this.nameInput.blur();
      this.rollInput.blur();
    }
    if (s === 'help') this.say(`How to play. ${HELP.join(' ')}`);
    this.placeInputs();
  }

  /** Screen-reader announcement. */
  private say(text: string) {
    this.live.textContent = text;
  }

  private moveMenu(d: number) {
    if (this.screen === 'menu') {
      this.sel = (this.sel + d + MENU.length) % MENU.length;
      this.say(MENU[this.sel]!);
    } else if (this.screen === 'login') {
      this.setFocus((this.focus + d + 4) % 4);
    }
    this.sfx.blip();
  }

  private setFocus(i: number) {
    this.focus = i;
    if (i === 0) this.nameInput.focus();
    else if (i === 1) this.rollInput.focus();
    else {
      this.nameInput.blur();
      this.rollInput.blur();
    }
  }

  private activate(i = this.sel) {
    this.sfx.confirm();
    if (this.screen === 'help') return this.toScreen('menu');
    if (this.screen === 'login') {
      if (i === 3) return this.toScreen('menu');
      return void this.submit();
    }
    this.sel = i;
    if (i === 0) this.toScreen('login');
    else if (i === 1) this.toScreen('help');
    else if (i === 2) location.href = '/siege/arena/?board=1';
    else location.href = '/siege/arena/';
  }

  private async submit() {
    if (this.busy) return;
    const name = this.nameInput.value.trim();
    const roll = this.rollInput.value.trim();
    if (!name) return this.fail('ENTER YOUR NAME FIRST', 0);
    if (!roll) return this.fail('ENTER YOUR ROLL NUMBER', 1);
    this.busy = true;
    this.message = { text: 'CONNECTING...', bad: false };
    const r = await this.opts.login(name, roll);
    this.busy = false;
    if (!r.ok) this.fail(r.error.toUpperCase(), null);
    else this.message = { text: 'WELCOME, SURVIVOR!', bad: false };
  }

  private fail(text: string, field: 0 | 1 | null) {
    this.message = { text, bad: true };
    this.say(text);
    this.sfx.error();
    if (field !== null) this.setFocus(field);
  }

  private toggleSound() {
    this.sfx.toggle();
    this.sfx.blip();
  }

  private toggleCrt() {
    this.crt = !this.crt;
    this.crtLayer.hidden = !this.crt;
    try {
      localStorage.setItem('siege.title.crt', this.crt ? '1' : '0');
    } catch {
      /* fine */
    }
    this.sfx.blip();
  }

  // ---- input ---------------------------------------------------------------------------------------------

  private bind() {
    const local = (e: PointerEvent): [number, number] => {
      const r = this.canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * this.W, ((e.clientY - r.top) / r.height) * this.H];
    };
    const hit = (x: number, y: number) => this.hits.find((h) => x >= h.rect.x && x < h.rect.x + h.rect.w && y >= h.rect.y && y < h.rect.y + h.rect.h);
    this.canvas.addEventListener('pointerdown', () => this.sfx.unlock());
    this.canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const h = hit(...local(e));
      h?.hover?.();
      this.canvas.style.cursor = h ? 'pointer' : 'default';
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const h = hit(...local(e));
      if (h) h.act();
      else if (this.screen === 'help') this.activate();
    });
    window.addEventListener('keydown', (e) => {
      if (!this.visible) return;
      this.sfx.unlock();
      const typing = document.activeElement === this.nameInput || document.activeElement === this.rollInput;
      if (e.key === 'ArrowUp' || (!typing && (e.key === 'w' || e.key === 'W'))) {
        e.preventDefault();
        this.moveMenu(-1);
      } else if (e.key === 'ArrowDown' || e.key === 'Tab' || (!typing && (e.key === 's' || e.key === 'S'))) {
        e.preventDefault();
        this.moveMenu(e.shiftKey && e.key === 'Tab' ? -1 : 1);
      } else if (e.key === 'Enter' || (!typing && e.key === ' ')) {
        e.preventDefault();
        if (this.screen === 'login' && typing && this.focus === 0) this.setFocus(1);
        else if (this.screen === 'login' && typing) this.activate(2);
        else this.activate(this.screen === 'login' ? this.focus : this.sel);
      } else if (e.key === 'Escape') {
        if (this.screen !== 'menu') this.toScreen('menu');
      } else if (!typing && (e.key === 'm' || e.key === 'M')) this.toggleSound();
      else if (!typing && (e.key === 'c' || e.key === 'C')) this.toggleCrt();
    });
    for (const [i, input] of [this.nameInput, this.rollInput].entries()) {
      input.addEventListener('focus', () => (this.focus = i));
      input.addEventListener('pointerdown', () => this.sfx.unlock());
    }
    this.root.querySelectorAll<HTMLButtonElement>('[data-title-item]').forEach((b) =>
      b.addEventListener('click', () => {
        this.sfx.unlock();
        this.activate(Number(b.dataset.titleItem));
      }),
    );
    window.addEventListener('resize', () => this.visible && this.layout());
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
  }

  // ---- live data -----------------------------------------------------------------------------------------

  private async fetchSummary() {
    try {
      const r = await fetch(this.opts.summaryUrl, { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      this.summary = (await r.json()) as Summary;
      this.offline = false;
    } catch {
      this.offline = true;
    }
  }

  // ---- drawing -------------------------------------------------------------------------------------------

  private draw() {
    const g = this.g;
    const { W, H } = this;
    this.hits = [];
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = themeVar('--title-panel');
    g.fillRect(0, 0, W, H);
    const [sx, sy] = this.scene?.shakeOffset() ?? [0, 0];
    g.translate(sx, sy);
    this.drawScores();
    this.drawLogo();
    const s = this.sceneRect();
    this.scene?.draw(g, s.x, s.y);
    chunkyFrame(g, s.x - 3, s.y - 3, s.w + 6, s.h + 6, 3, false);
    if (this.screen === 'menu') this.drawMenu();
    else this.drawPanel();
    if (this.portrait || this.screen !== 'help') this.drawSide();
    this.drawCredit();
    g.setTransform(1, 0, 0, 1, 0, 0);
    chunkyFrame(g, 0, 0, W, H, 6);
  }

  private drawScores() {
    const g = this.g;
    const top = this.summary?.top ?? [];
    const rankC = themeVar('--title-rank');
    const nameC = themeVar('--title-text');
    const scoreC = themeVar('--title-score');
    if (this.offline && !this.summary) {
      const t = pixelText('SERVER OFFLINE', 8, themeVar('--title-error'));
      g.drawImage(t, Math.round((this.W - t.width) / 2), this.portrait ? 20 : 9);
      return;
    }
    const rows = [0, 1, 2].map((i) => top[i]);
    rows.forEach((p, i) => {
      // Landscape: three columns "1 NAME 56"; portrait: three rows with the score right-aligned.
      const nameLen = this.portrait ? 10 : 5;
      const name = (p ? p.name : '---').toUpperCase().replace(/[^A-Z0-9 .'-]/g, '').slice(0, nameLen);
      const score = p ? String(Math.min(9999, p.trophies)) : '0';
      const x = this.portrait ? 12 : 12 + i * 102;
      const y = this.portrait ? 10 + i * 10 : 9;
      g.drawImage(pixelText(String(i + 1), 8, rankC), x, y);
      g.drawImage(pixelText(name, 8, nameC), x + 11, y);
      const sc = pixelText(score, 8, scoreC);
      g.drawImage(sc, this.portrait ? this.W - 12 - sc.width : x + 11 + name.length * 8 + 5, y);
    });
  }

  /** The logo image: thick outline, drop shadow and a banded fire gradient, built once per size. */
  private buildLogo(): HTMLCanvasElement {
    const lines = this.portrait ? ['CODE', 'SIEGE'] : ['CODE SIEGE'];
    const size = this.portrait ? 32 : 24;
    const lh = size + 4;
    const pad = 4;
    const width = Math.max(...lines.map((l) => l.length * size)) + pad * 2;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = lines.length * lh + pad * 2;
    const g = c.getContext('2d')!;
    const outline = themeVar('--title-logo-outline');
    const shadow = themeVar('--title-logo-shadow');
    lines.forEach((line, i) => {
      const x = pad + Math.round((width - pad * 2 - line.length * size) / 2);
      const y = pad + i * lh;
      const sh = pixelText(line, size, shadow);
      g.drawImage(sh, x + 3, y + 3);
      const ol = pixelText(line, size, outline);
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) if (Math.abs(dx) + Math.abs(dy) <= 3 && (dx || dy)) g.drawImage(ol, x + dx, y + dy);
      // Fire gradient in hard bands, clipped to the letters.
      const fill = document.createElement('canvas');
      fill.width = line.length * size;
      fill.height = size;
      const fg = fill.getContext('2d')!;
      fg.drawImage(pixelText(line, size, '#ffffff'), 0, 0);
      // source-atop paints each band onto the letters only, leaving the bands already painted.
      fg.globalCompositeOperation = 'source-atop';
      const stops = ['--title-logo-1', '--title-logo-2', '--title-logo-3', '--title-logo-4', '--title-logo-5'].map(themeVar);
      const band = Math.ceil(size / stops.length);
      stops.forEach((col, k) => {
        fg.fillStyle = col;
        fg.fillRect(0, k * band, fill.width, band);
      });
      g.drawImage(fill, x, y);
    });
    return c;
  }

  private drawLogo() {
    const g = this.g;
    const logo = (this.logo ??= this.buildLogo());
    const x = Math.round((this.W - logo.width) / 2);
    const y = this.portrait ? 42 : 18;
    // Now and then: a short glitch (sliced and shifted rows); otherwise a slow, faint flicker.
    if (this.time > this.nextGlitch) {
      this.glitchUntil = this.time + 0.18;
      this.nextGlitch = this.time + 3 + Math.random() * 5;
    }
    if (this.time < this.glitchUntil) {
      for (let row = 0; row < logo.height; row += 3) {
        const shift = Math.random() < 0.3 ? Math.round((Math.random() - 0.5) * 6) : 0;
        g.drawImage(logo, 0, row, logo.width, 3, x + shift, y + row, logo.width, 3);
      }
      return;
    }
    g.globalAlpha = Math.random() < 0.004 ? 0.85 : 1;
    g.drawImage(logo, x, y);
    g.globalAlpha = 1;
  }

  private item(text: string, x: number, y: number, on: boolean, act: () => void, hover: () => void) {
    const g = this.g;
    const img = pixelText(text, 8, on ? themeVar('--title-menu-on') : themeVar('--title-text'));
    g.drawImage(img, x + 10, y);
    if (on && Math.floor(this.time * 3) % 2 === 0) arrow(g, x, y, themeVar('--title-menu-on'));
    this.hits.push({ rect: { x: x - 4, y: y - 3, w: img.width + 18, h: 14 }, act, hover });
  }

  private drawMenu() {
    const x = this.portrait ? 22 : 26;
    const y0 = this.portrait ? 222 : 124;
    const step = this.portrait ? 13 : 11;
    MENU.forEach((label, i) =>
      this.item(label, x, y0 + i * step, i === this.sel, () => this.activate(i), () => {
        if (this.sel !== i) {
          this.sel = i;
          this.sfx.blip();
        }
      }),
    );
  }

  private drawPanel() {
    const g = this.g;
    const p = this.panelRect();
    g.fillStyle = themeVar('--title-panel');
    g.globalAlpha = 0.94;
    g.fillRect(p.x, p.y, p.w, p.h);
    g.globalAlpha = 1;
    chunkyFrame(g, p.x - 2, p.y - 2, p.w + 4, p.h + 4, 3, false);
    if (this.screen === 'help') return this.drawHelp(p);
    // Whichever real input has focus is the highlighted field (also catches taps straight onto a field).
    if (document.activeElement === this.nameInput) this.focus = 0;
    else if (document.activeElement === this.rollInput) this.focus = 1;
    const labels = ['ENTER NAME', 'ROLL NUMBER'];
    const values = [this.nameInput.value, this.rollInput.value];
    for (const i of [0, 1] as const) {
      const f = this.fieldRect(i);
      const on = this.focus === i;
      g.drawImage(pixelText(labels[i]!, 8, on ? themeVar('--title-menu-on') : themeVar('--title-dim')), f.x, f.y - 10);
      g.fillStyle = themeVar('--title-field');
      g.fillRect(f.x, f.y, f.w, f.h);
      g.fillStyle = on ? themeVar('--title-menu-on') : themeVar('--title-field-line');
      g.fillRect(f.x, f.y + f.h - 1, f.w, 1);
      const max = Math.floor((f.w - 12) / 8);
      const text = values[i]!.toUpperCase();
      const shown = text.length > max ? text.slice(text.length - max) : text;
      const img = pixelText(shown || ' ', 8, themeVar('--title-text'));
      g.drawImage(img, f.x + 3, f.y + 3);
      if (on && Math.floor(this.time * 2.5) % 2 === 0) {
        g.fillStyle = themeVar('--title-cursor');
        g.fillRect(f.x + 3 + shown.length * 8, f.y + 3, 7, 8);
      }
      this.hits.push({ rect: f, act: () => this.setFocus(i) });
    }
    const by = this.fieldRect(1).y + (this.portrait ? 26 : 22);
    LOGIN_ITEMS.forEach((label, k) => {
      const i = k + 2;
      const x = this.portrait ? p.x + 12 : p.x + 12 + k * 90;
      const y = this.portrait ? by + k * 13 : by;
      this.item(label, x, y, this.focus === i, () => this.activate(i), () => {
        if (this.focus !== i) {
          this.setFocus(i);
          this.sfx.blip();
        }
      });
    });
    if (this.message) {
      const col = this.message.bad ? themeVar('--title-error') : themeVar('--title-good');
      const lines = wrap(this.message.text, Math.floor((p.w - 12) / 4));
      const y0 = p.y + p.h - 4 - lines.length * 7;
      lines.forEach((l, k) => tinyText(g, l, p.x + 6, y0 + k * 7, col));
    } else {
      tinyText(g, 'ONE BASE PER ROLL NUMBER', p.x + 6, p.y + p.h - 10, themeVar('--title-dim'));
    }
  }

  private drawHelp(p: Rect) {
    const g = this.g;
    g.drawImage(pixelText('HOW TO PLAY', 8, themeVar('--title-menu-on')), p.x + 8, p.y + 6);
    let y = p.y + 20;
    const max = Math.floor((p.w - 16) / 4);
    for (const para of HELP) {
      for (const line of wrap(para, max)) {
        tinyText(g, line, p.x + 8, y, themeVar('--title-text'));
        y += 7;
      }
      y += 3;
    }
    this.item('BACK', p.x + 8, p.y + p.h - 12, true, () => this.activate(), () => undefined);
  }

  private drawSide() {
    const g = this.g;
    const online = this.offline ? '--' : String(this.summary?.online ?? 0).padStart(2, '0');
    const label = pixelText('ONLINE', 8, themeVar('--title-dim'));
    const count = pixelText(online, 8, this.offline ? themeVar('--title-error') : themeVar('--title-good'));
    const x = this.portrait ? Math.round((this.W - label.width - 8 - count.width) / 2) : 206;
    const y = this.portrait ? 277 : 126;
    g.drawImage(label, x, y);
    g.drawImage(count, x + label.width + 8, y);
    // Sound and CRT toggles (also M and C on a keyboard).
    const boxes: [string, () => void][] = [
      [this.sfx.muted ? 'SOUND OFF' : 'SOUND ON', () => this.toggleSound()],
      [this.crt ? 'CRT ON' : 'CRT OFF', () => this.toggleCrt()],
    ];
    const bw = 48;
    const bh = 11;
    const bx0 = this.portrait ? Math.round((this.W - bw * 2 - 6) / 2) : 206;
    const by = this.portrait ? 288 : 142;
    boxes.forEach(([text, act], i) => {
      const bx = bx0 + i * (bw + 6);
      g.fillStyle = themeVar('--title-field');
      g.fillRect(bx, by, bw, bh);
      g.fillStyle = themeVar('--title-field-line');
      g.fillRect(bx, by + bh - 1, bw, 1);
      tinyText(g, text, bx + Math.round((bw - tinyWidth(text)) / 2), by + 3, themeVar('--title-text'));
      this.hits.push({ rect: { x: bx, y: by, w: bw, h: bh }, act });
    });
    if (!this.portrait) tinyText(g, 'M: SOUND   C: CRT', 206, 158, themeVar('--title-dim'));
  }

  private drawCredit() {
    const g = this.g;
    const col = themeVar('--title-dim');
    const lines = this.portrait ? ['ART: POST-APOCALYPSE PACK', 'BY THELAZYSTONE  IETE-SF'] : ['ART: POST-APOCALYPSE PACK BY THELAZYSTONE  ·  IETE-SF MPSTME'];
    lines.forEach((l, i) => tinyText(g, l, Math.round((this.W - tinyWidth(l)) / 2), this.portrait ? 302 + i * 7 : 168, col));
  }
}
