import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Dev: the site runs on Vite (SIEGE_DEV_PORT, 5173) and forwards game traffic to the game server.
// Production: the game server serves the built site itself, so nothing is proxied.
// Settings come from the same `.env` at the repo root as the server's (see .env.example).
const ROOT = resolve(__dirname, '..');
for (const file of [resolve(ROOT, '.env'), resolve(ROOT, 'server/.env')]) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* no such file */
  }
}
const GAME_SERVER = `http://localhost:${process.env.SIEGE_PORT || 3000}`;

export default defineConfig({
  // VITE_* settings (VITE_SIEGE_SERVER_URL) are read from the root .env too.
  envDir: ROOT,
  server: {
    port: Number(process.env.SIEGE_DEV_PORT || 5173),
    proxy: {
      '/socket.io': { target: GAME_SERVER, ws: true },
      '/api': GAME_SERVER,
    },
    fs: { allow: [ROOT] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        siege: resolve(__dirname, 'siege/index.html'),
        arena: resolve(__dirname, 'siege/arena/index.html'),
        admin: resolve(__dirname, 'siege/admin/index.html'),
      },
    },
  },
});
