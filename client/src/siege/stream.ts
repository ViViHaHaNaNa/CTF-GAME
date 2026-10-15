import { CONFIG, type RaidResult, type RaidStatus, type Snapshot } from '@siege/shared';
import type { Socket } from 'socket.io-client';
import type { LiveState, WorldView } from './world.ts';

// Live combat streams for the bases a screen watches (zombie waves and raids), shared by the game
// page and the Live Arena. Pages add their own listeners for the same events on top.

export interface BaseLive {
  p: number;
  phase: LiveState['phase'];
  nextIn?: number;
  snapshot?: Snapshot;
  raid?: RaidStatus;
}

export function bindLiveStream(socket: Socket, view: WorldView) {
  /** Let the last death animations play, then clear the field. */
  const clearLater = (plot: number) => {
    setTimeout(() => {
      const l = view.live.get(plot);
      if (l && (l.phase === 'calm' || l.phase === 'warning')) view.resetCombat(plot);
    }, 900);
  };

  const onLive = (b: BaseLive) => {
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
  };

  socket.on('live', onLive);
  socket.on('wave', onLive);
  socket.on('snap', (m: Snapshot & { p: number }) => view.applySnapshot(m.p, m, performance.now()));
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
    l.riseAt = performance.now() + CONFIG.waves.calm * 1000;
    clearLater(r.plot);
  });
}
