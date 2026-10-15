# Code Siege v2: notes

Apocalyptic base-defence + PvP game for the IETE-SF fest, served at `/siege` inside a small site shell.
This file tracks decisions and how to run things. The brief is the source of truth for scope.

## How to run

Needs Node.js 22.

```bash
npm install
npm run dev      # site + game on http://localhost:5173/siege/ (hot reload); game server on :3000
npm test         # combat engine, economy, server rules, persistence
npm start        # production: builds the site, one process serves everything on :3000
```

Phones on the same wifi use the LAN address printed at startup.

| Setting | Where | Default |
|---|---|---|
| Game server address (client) | `VITE_SIEGE_SERVER_URL` in `client/.env` | same address as the page |
| Game server port / bind | `SIEGE_PORT`, `SIEGE_HOST` | `3000`, `0.0.0.0` |
| Database file | `SIEGE_DB` | `server/data/siege.db` |

Moving the game server to the cloud: run `server` there, set `VITE_SIEGE_SERVER_URL` to its URL, rebuild the client.

## Layout

```
shared/   config.ts (ALL balance numbers), layout.ts (fixed base), engine.ts (combat), pve.ts (waves),
          economy.ts (build/upgrade rules), types.ts
server/   index.ts (http + socket.io + game loop), game.ts (authoritative state), net.ts (protocol),
          store.ts (storage interface + SQLite), data/questions.json (crate question bank)
client/   index.html (site home), siege/index.html (game page), src/siege/* (canvas + UI)
client/public/game-assets/postapocalypse/   the art pack, unmodified, with its LICENSE.txt
```

## Decisions

- **Stack**: Node + TypeScript workspaces. Fastify + socket.io on the server, Vite + plain TypeScript (no framework) on the client. SQLite via better-sqlite3 behind a `Store` interface; every change is written immediately.
- **Authority**: the server owns coins, levels and combat. The client sends intents (`login`, `act`) and renders snapshots.
- **Combat engine** (`shared/src/engine.ts`): fixed 20 ticks/s, seeded RNG, no wall clock. Units walk straight at their target and hack through anything solid in the way; posts shoot the nearest unit in range. The same engine will run PvP in phase 2.
- **Waves**: every wave is determined by (base, seed), so online (streamed at 10 snapshots/s) and offline (resolved instantly) play out identically. A wave never causes lasting damage. A breach (Main Tower falls) costs 10% of coins, max 300, never below 100.
- **Offline**: a headless wave every 45 s; coins go into a bank capped at 500, credited with a summary at the next login.
- **Upgrades** are instant but join the fight from the next wave (the running wave keeps the layout it started with).
- **Base**: fixed 20x20 map, walled 14x14 compound, Main Tower in the middle, 8 post slots unlocked by Main Tower level (2, 3, 4 ... 8).
- **Survivor posts** are layered sprites (body without hands + weapon-with-hands + helmet from Lv 4). Layer offsets live in `client/src/siege/sprites.ts` if anything looks misaligned.
- **Main Tower** has no sprite in the pack: it's a shipping container that changes colour and gains antennas/AC/barrels with level.
- **Login**: display name + roll number; one account per roll number and the name must match on return. The session token lives in localStorage.
- **Questions**: 13 short-answer questions (fill-in-the-blank, predict-the-output) carried over from v1. v1's write-a-function questions were dropped (they needed a code sandbox).
- **Pacing** (from `shared/scripts/pve-balance.ts`): about 22 coins/min at the start, 39/min with two pistols, around 93/min at Main Tower Lv 2; new players start with 120 coins, enough for a second post straight away.

## Asset licence (important)

PostApocalypse_AssetPack_v1.1.2 by TheLazyStone: free for **non-commercial** use, **no redistribution**. Keep this repo private (don't push it to a public GitHub repo or share zips of it), and if the fest is commercial or sponsored, pay the $2 commercial licence. Credit is in the game footer.

## Phase log

- **Phase 1** (core loop): done. Login, fixed base, posts/walls/Main Tower upgrades, live + offline zombie waves, coins, persistence, reconnect.
