import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Dev: the site runs on Vite (5173) and forwards game traffic to the game server.
// Production: the game server serves the built site itself, so nothing is proxied.
const GAME_SERVER = `http://localhost:${process.env.SIEGE_PORT ?? 3000}`;

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: GAME_SERVER, ws: true },
      '/api': GAME_SERVER,
    },
    fs: { allow: [resolve(__dirname, '..')] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        siege: resolve(__dirname, 'siege/index.html'),
      },
    },
  },
});
