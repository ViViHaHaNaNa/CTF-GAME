import { isAbsolute, join, resolve } from 'node:path';

// Every server setting in one place, for the server and the scripts (bots, reset, backup).
// Where they come from, first one wins: real environment variables, then `.env` at the repo root
// (copy `.env.example`), then the older `server/.env` (still read so existing setups keep working).
// Paths may be relative: they're taken from the repo root, whatever folder a script runs in.

export const ROOT = resolve(import.meta.dirname, '../..');

for (const file of [join(ROOT, '.env'), join(ROOT, 'server/.env')]) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* no such file: defaults and real environment variables only */
  }
}

const env = (name: string) => {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
};
const path = (v: string | undefined, fallback: string) => (v ? (isAbsolute(v) ? v : resolve(ROOT, v)) : join(ROOT, fallback));
const yes = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? '');

/** `npm start` (the real event) runs the server with --event: DEV_MODE can never switch on there. */
export const EVENT = process.argv.includes('--event');

export const SETTINGS = {
  /** The game server's port (and, with `npm start`, the website's). */
  port: Number(env('SIEGE_PORT') ?? 3000),
  /** 0.0.0.0 = reachable from other devices on the network (phones). */
  host: env('SIEGE_HOST') ?? '0.0.0.0',
  /** The website's port during `npm run dev` (Vite). */
  devPort: Number(env('SIEGE_DEV_PORT') ?? 5173),
  /** Passphrase for /siege/admin/ (unset = admin page off). */
  adminPass: env('SIEGE_ADMIN_PASS'),
  db: path(env('SIEGE_DB'), 'server/data/siege.db'),
  backups: path(env('SIEGE_BACKUPS'), 'server/data/backups'),
  questions: path(env('SIEGE_QUESTIONS'), 'server/data/questions.json'),
  /** Development helpers: the 8 bot accounts on an empty database, a crate waiting at start. Never on for the event. */
  devMode: !EVENT && yes(env('DEV_MODE')),
  /** DEV_MODE was asked for but this is the event build (ignored, with a warning). */
  devModeRefused: EVENT && yes(env('DEV_MODE')),
};
