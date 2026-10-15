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
shared/   config.ts (ALL balance numbers), world.ts (the shared map), layout.ts (one base plot), engine.ts (combat),
          pve.ts (waves), pvp.ts (raids), economy.ts (build/upgrade rules), types.ts
server/   index.ts (http + socket.io + game loop), game.ts (authoritative state), net.ts (protocol),
          store.ts (storage interface + SQLite), data/questions.json (crate question bank)
client/   index.html (site home), siege/index.html (game page), src/siege/world.ts (map renderer), main.ts (UI)
client/public/game-assets/postapocalypse/   the art pack, unmodified, with its LICENSE.txt
client/public/game-assets/graveyard/        grave_1..4.png (our own; replace freely, see shared/scripts/draw-graves.py)
```

## Decisions

- **Stack**: Node + TypeScript workspaces. Fastify + socket.io on the server, Vite + plain TypeScript (no framework) on the client. SQLite via better-sqlite3 behind a `Store` interface; every change is written immediately.
- **Authority**: the server owns coins, levels and combat. The client sends intents (`login`, `act`) and renders snapshots.
- **Combat engine** (`shared/src/engine.ts`): fixed 20 ticks/s, seeded RNG, no wall clock. Units walk straight at their target and hack through anything solid in the way; posts shoot the nearest unit in range. The same engine will run PvP in phase 2.
- **Waves**: every wave is determined by (base, seed), so online (streamed at 10 snapshots/s) and offline (resolved instantly) play out identically. A wave never causes lasting damage. A breach (Main Tower falls) costs 10% of coins, max 300, never below 100.
- **Offline**: a headless wave every 45 s; coins go into a bank capped at 500, credited with a summary at the next login.
- **Upgrades** are instant but join the fight from the next wave (the running wave keeps the layout it started with).
- **Open world** (`shared/src/world.ts`): one 180x180-tile map built from a fixed seed, so server and every client generate the identical map with nothing sent over the wire. 64 plots of 14x14 in 2x2 blocks, 2-tile roads between blocks, ~900 scenery props. New players get the free plot nearest the centre; empty plots show faded ruins.
- **Base**: a 14x14 plot with a walled compound (36 wall pieces), Main Tower in the middle, 8 post slots unlocked by Main Tower level (2, 3, 4 ... 8). The ring of ground outside the walls is the raid deployment zone.
- **Graveyards**: one 5x5 mud patch with 6-10 graves at the centre of each block, serving its 4 bases (walk of about 5-15 tiles, never through another compound; checked by `shared/scripts/world-check.ts`). Zombies rise there (the death animation played backwards plus a dirt puff) and only target their own base. A pulsing marker shows over the graveyard and on the minimap during the warning and the wave.
- **Area of interest**: each screen tells the server which bases it's looking at (up to 6 nearest in view at zoom 2 or more, plus its own and any raid target). Only those get live waves and snapshot streams; every other base resolves waves headlessly every 45 s. Everyone gets a small world summary (levels, trophies, shield, raid, wave flag) on connect and changes every 0.5 s.
- **Rendering**: integer zoom only (crisp pixels). Ground, graves and scenery are baked into 512px chunks once; quiet bases are cached as one image; only watched bases animate. Name tags are drawn in screen pixels.
- **Raids (PvP)** run on the map where the base is: the attacker taps the red zone around the target to send raiders (coins charged by the server). 3 minutes; win by destroying the Main Tower or 50% of buildings; ends early after 20 s with nobody left. Loot is 20% of the defender's coins (capped at 300 + 150 per Main Tower level, never taking them below 100), reduced when attacking much weaker players. Trophies: 30 +/- 5% of the gap (5-50); a loss costs the attacker half. The defender gets a 2-minute shield. Anyone can spectate from the Live list or a base's card.
- **Dev server gotcha**: `tsx watch` can miss edits to `shared/`; if the server behaves like old code, restart `npm run dev`.
- **Survivor posts** are layered sprites (body without hands + weapon-with-hands + helmet from Lv 4). Layer offsets live in `client/src/siege/sprites.ts` if anything looks misaligned.
- **Main Tower** has no sprite in the pack: it's a shipping container that changes colour and gains antennas/AC/barrels with level.
- **Login**: display name + roll number; one account per roll number and the name must match on return. The session token lives in localStorage.
- **Questions**: 13 short-answer questions (fill-in-the-blank, predict-the-output) carried over from v1. v1's write-a-function questions were dropped (they needed a code sandbox).
- **Pacing** (from `shared/scripts/pve-balance.ts`): about 22 coins/min at the start, 39/min with two pistols, around 93/min at Main Tower Lv 2; new players start with 120 coins, enough for a second post straight away.

## Asset licence (important)

PostApocalypse_AssetPack_v1.1.2 by TheLazyStone: free for **non-commercial** use, **no redistribution**. Keep this repo private (don't push it to a public GitHub repo or share zips of it), and if the fest is commercial or sponsored, pay the $2 commercial licence. Credit is in the game footer.

## Phase log

- **Phase 1** (core loop): done. Login, fixed base, posts/walls/Main Tower upgrades, live + offline zombie waves, coins, persistence, reconnect.
- **Phase 2** (open world + PvP): shared map, graveyards, raids in place, spectating, minimap, leaderboard, live-battle list, event feed. Not yet: leaderboard big-screen mode, matchmaking "next target" list.
