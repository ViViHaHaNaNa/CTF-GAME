import { decodeSnapshot, type RaidResult, type RaidStatus } from '@siege/shared';
import type { Socket } from 'socket.io-client';
import type { LiveState, WorldView } from './world.ts';

// Live combat streams for the bases a screen watches (zombie sieges and raids), shared by the game
// page and the Live Arena. Snapshots arrive packed (see shared/snapcodec.ts). Pages add their own
// listeners for the same events on top.

export interface BaseLive {
  p: number;
  phase: LiveState['phase'];
  siege?: { n: number; phase: string; nextIn: number };
  snapshot?: ArrayBuffer;
  raid?: RaidStatus;
}

export interface SiegeMessage {
  p: number;
  type: 'surge' | 'held' | 'breach';
  n: number;
  size?: number;
  sides?: number[];
  pincer?: boolean;
  kills?: number;
  coins?: number;
  lost?: number;
  total?: number;
}

export function bindLiveStream(socket: Socket, view: WorldView) {
  /** Let the last death animations play, then clear the field. */
  const clearLater = (plot: number) => {
    setTimeout(() => {
      const l = view.live.get(plot);
      if (l && l.phase === 'calm') view.resetCombat(plot);
    }, 900);
  };

  const onLive = (b: BaseLive) => {
    const now = performance.now();
    const l = view.liveFor(b.p);
    l.phase = b.phase;
    l.raid = b.raid ?? null;
    l.siege = b.siege ?? null;
    if (b.snapshot) {
      view.resetCombat(b.p);
      view.applySnapshot(b.p, decodeSnapshot(b.snapshot), now);
    }
    if (b.phase === 'calm') clearLater(b.p);
  };

  socket.on('live', onLive);
  socket.on('wave', onLive);
  socket.on('snap', (buf: ArrayBuffer) => {
    const s = decodeSnapshot(buf);
    view.applySnapshot(s.p, s, performance.now());
  });
  socket.on('siege', (m: SiegeMessage) => {
    const l = view.live.get(m.p);
    if (!l) return;
    l.siege = { n: m.n, phase: m.type === 'surge' ? 'surge' : 'breather' };
  });
  socket.on('raid', (r: RaidStatus) => {
    const l = view.liveFor(r.plot);
    if (l.phase !== 'raid') {
      view.resetCombat(r.plot);
      l.phase = 'raid';
    }
    l.raid = r;
  });
  socket.on('raidEnd', (r: RaidResult) => {
    const l = view.live.get(r.plot);
    if (l?.phase !== 'raid') return;
    l.phase = 'calm';
    l.raid = null;
    clearLater(r.plot);
  });
}
