import { io, type Socket } from 'socket.io-client';
import type { BaseAction, PlayerView, RaidStatus } from '@siege/shared';
import { SERVER_URL } from './config.ts';

// Socket connection to the authoritative game server. The browser only sends intents.

const TOKEN_KEY = 'siege.token';

export function savedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session just won't survive a reload */
  }
}

/** A read-only connection for the Live Arena / projector: no login, can only watch. */
export function spectatorSocket(): Socket {
  return io(SERVER_URL ?? '/', {
    auth: { spectator: true },
    transports: ['websocket', 'polling'],
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
  });
}

type Ack<T> ={ ok: true } & T | { ok: false; error: string };

export class Net {
  readonly socket: Socket;

  constructor() {
    // The token is read on every (re)connect, so a reconnect resumes the right player.
    this.socket = io(SERVER_URL ?? '/', {
      auth: (cb) => cb({ token: savedToken() }),
      transports: ['websocket', 'polling'],
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
  }

  private call<T>(event: string, data: unknown): Promise<Ack<T>> {
    return new Promise((resolve) => {
      if (!this.socket.connected) return resolve({ ok: false, error: 'Not connected to the game server' });
      this.socket.timeout(8000).emit(event, data, (err: Error | null, res: Ack<T>) => {
        resolve(err ? { ok: false, error: 'The server did not answer. Try again.' } : res);
      });
    });
  }

  login(name: string, roll: string) {
    return this.call<{ token: string }>('login', { name, roll });
  }

  act(action: BaseAction) {
    return this.call<{ player: PlayerView }>('act', action);
  }

  /** The plots this screen is looking at (area of interest), nearest first. */
  watch(plots: number[]) {
    this.socket.emit('watch', { plots });
  }

  attack(plot: number) {
    return this.call<{ raid: RaidStatus }>('attack', { plot });
  }

  deploy(kind: string, x: number, y: number) {
    return this.call<{ coins: number }>('deploy', { kind, x, y });
  }

  retreat() {
    this.socket.emit('retreat');
  }

  /** A Commander shot at world tiles (no answer: the result comes back as 'tap'). */
  tap(x: number, y: number) {
    this.socket.emit('tap', { x, y });
  }

  reload() {
    this.socket.emit('reload');
  }

  /** Start the next surge now, for bonus coins. */
  callEarly() {
    return this.call<{ bonus: number }>('callEarly', {});
  }

  airstrike(x: number, y: number) {
    return this.call<{ ready: number }>('airstrike', { x, y });
  }

  /** Grind (pve) or Raid (pvp). */
  setMode(mode: 'pve' | 'pvp') {
    return this.call<{ player: PlayerView }>('mode', { mode });
  }

  buyImmunity(minutes: number) {
    return this.call<{ player: PlayerView }>('immunity', { minutes });
  }

  answer(crate: number, answer: string) {
    return this.call<{ correct: boolean; retryIn?: number; reward?: string }>('answer', { crate, answer });
  }

  logout() {
    this.socket.emit('logout');
  }
}
