import type { Snapshot } from './types.ts';

// Combat snapshots on the wire, packed into bytes: a siege can have 100+ zombies on one base and every
// screen watches several bases, so JSON would be ~4x bigger. Little-endian, versioned.
//
//   header   u8 version, u16 plot, u32 tick, u16 units, u16 buildings, u16 shots
//   unit     u16 id, u8 kind, u16 x, u16 y (world px), u8 hp %, u8 state | (facing left ? 4 : 0)   9 bytes
//   building u16 id, u8 hp %                                                                    3 bytes
//   shot     u16 shooter id, u16 x, u16 y                                                        6 bytes

const VERSION = 1;
const HEAD = 13;
const U16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)));

export function encodeSnapshot(plot: number, s: Snapshot): Uint8Array {
  const buf = new Uint8Array(HEAD + s.u.length * 9 + s.b.length * 3 + s.s.length * 6);
  const v = new DataView(buf.buffer);
  v.setUint8(0, VERSION);
  v.setUint16(1, plot, true);
  v.setUint32(3, s.t, true);
  v.setUint16(7, s.u.length, true);
  v.setUint16(9, s.b.length, true);
  v.setUint16(11, s.s.length, true);
  let o = HEAD;
  for (const [id, kind, x, y, hp, state, facing] of s.u) {
    v.setUint16(o, id, true);
    v.setUint8(o + 2, kind);
    v.setUint16(o + 3, U16(x), true);
    v.setUint16(o + 5, U16(y), true);
    v.setUint8(o + 7, hp);
    v.setUint8(o + 8, state | (facing < 0 ? 4 : 0));
    o += 9;
  }
  for (const [id, hp] of s.b) {
    v.setUint16(o, id, true);
    v.setUint8(o + 2, hp);
    o += 3;
  }
  for (const [id, x, y] of s.s) {
    v.setUint16(o, id, true);
    v.setUint16(o + 2, U16(x), true);
    v.setUint16(o + 4, U16(y), true);
    o += 6;
  }
  return buf;
}

export function decodeSnapshot(data: ArrayBuffer | Uint8Array): Snapshot & { p: number } {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(0) !== VERSION) throw new Error('Unknown snapshot version');
  const p = v.getUint16(1, true);
  const t = v.getUint32(3, true);
  const nu = v.getUint16(7, true);
  const nb = v.getUint16(9, true);
  const ns = v.getUint16(11, true);
  const u: Snapshot['u'] = new Array(nu);
  const b: Snapshot['b'] = new Array(nb);
  const s: Snapshot['s'] = new Array(ns);
  let o = HEAD;
  for (let i = 0; i < nu; i++, o += 9) {
    const sf = v.getUint8(o + 8);
    u[i] = [v.getUint16(o, true), v.getUint8(o + 2), v.getUint16(o + 3, true), v.getUint16(o + 5, true), v.getUint8(o + 7), sf & 3, sf & 4 ? -1 : 1];
  }
  for (let i = 0; i < nb; i++, o += 3) b[i] = [v.getUint16(o, true), v.getUint8(o + 2)];
  for (let i = 0; i < ns; i++, o += 6) s[i] = [v.getUint16(o, true), v.getUint16(o + 2, true), v.getUint16(o + 4, true)];
  return { p, t, u, b, s };
}
