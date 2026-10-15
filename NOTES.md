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

| Page | URL |
|---|---|
| Game | `/siege/` |
| Live Arena (watch only, no login) | `/siege/arena/` |
| Projector (auto-cycles battles, big leaderboard when idle) | `/siege/arena/?projector=1`, then press Fullscreen |

| Setting | Where | Default |
|---|---|---|
| Game server address (client) | `VITE_SIEGE_SERVER_URL` in `client/.env` | same address as the page |
| Game server port / bind | `SIEGE_PORT`, `SIEGE_HOST` | `3000`, `0.0.0.0` |
| Database file | `SIEGE_DB` | `server/data/siege.db` |
| Crate question bank | `SIEGE_QUESTIONS` | `server/data/questions.json` |

Moving the game server to the cloud: run `server` there, set `VITE_SIEGE_SERVER_URL` to its URL, rebuild the client.

## Layout

```
shared/   config.ts (ALL balance numbers), world.ts (the shared map), layout.ts (one base plot), engine.ts (combat),
          pve.ts (waves), pvp.ts (raids), crates.ts (answer checks, rarity, boosts), economy.ts, types.ts
server/   index.ts (http + socket.io + game loop), game.ts (authoritative state), net.ts (protocol),
          store.ts (storage interface + SQLite), data/questions.json (crate question bank)
client/   index.html (site home), siege/index.html (game page), siege/arena/index.html (Live Arena)
          src/siege/world.ts (map renderer), stream.ts (live battle streams), main.ts (game UI), arena.ts (arena UI)
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
- **Immunity**: buy 5 min (150 coins) or 10 min (250) of protection from raids; buying again extends it, up to 15 min left. It doesn't stop zombies. Attacking anyone ends it. Immune bases show the shield icon and can't be targeted (the card says why).
- **Crates**: one global crate every 10 minutes (first one 1 minute after the server starts), landing at the crossroads in the middle of the map with a question from the bank. No question repeats until the bank is used up; an unclaimed crate expires when the next one drops. The schedule, the used-question list and the current crate are saved in the database (`meta` table), so a restart doesn't reset them. Answers are checked only on the server and never sent to clients until the crate is claimed. Checking ignores case, outer quotes, a trailing `;`, commas and extra spaces (and for fill-in-the-blank, all spacing). Wrong answers: 3 s wait, and every 5th wrong answer locks you out for 30 s. **Exactly one winner**: the check and the claim run in one synchronous step on the single game thread, so two answers arriving together are handled one after the other and the second is told who won.
- **Crate rewards**: rarity green 60% / blue 30% / red 10% (`CONFIG.crates.weights`), and the rarity sets the strength. A random boost the player doesn't already have at a stronger level: attack (+25/40/60% raider damage, next 3 raids), defence (+25/40/60% post damage and health for 30 min, in waves and raids), loot (+50/75/100% on the next raid, still never taking a defender below 100 coins). One boost of each type; an equal or stronger one replaces it. If every type is already stronger, the winner gets coins instead.
- **Spectating**: the Live Arena connects as a spectator (socket auth `{spectator: true}`, no login, no token). It gets the world summary, feed and crate, can watch at most 2 bases, and every other request is refused. It joins the same per-base battle stream (`base:<plot>` room) the attacker and defender use, so it sees exactly what they see. It auto-picks a live battle and moves to the next one when it ends (after a 6 s result card). Projector mode also rotates between live battles every 20 s, uses big type, and shows a large leaderboard over a slowly drifting map when nothing is happening. Players can also spectate inside the game (a base's card or the Live list).
- **Feed** also announces rank changes: climbing into the top 3, or to #1, after a raid.
- **Dev server gotcha**: `tsx watch` can miss edits to `shared/`; if the server behaves like old code, restart `npm run dev`.
- **Survivor posts** are layered sprites (body without hands + weapon-with-hands + helmet from Lv 4). Layer offsets live in `client/src/siege/sprites.ts` if anything looks misaligned.
- **Main Tower** has no sprite in the pack: it's a shipping container that changes colour and gains antennas/AC/barrels with level.
- **Login**: display name + roll number; one account per roll number and the name must match on return. The session token lives in localStorage.
- **Questions**: 30 short-answer questions (fill-in-the-blank, predict-the-output) in C, C++ and Python: 13 from v1 plus 17 new ones, each checked by actually running the code. v1's write-a-function questions were dropped (they needed a code sandbox). Add more by editing `server/data/questions.json` (id, prompt, code, lang, kind, answers, difficulty) and restarting the server; a test checks every question accepts its own answers.
- **Pacing** (from `shared/scripts/pve-balance.ts`): about 22 coins/min at the start, 39/min with two pistols, around 93/min at Main Tower Lv 2; new players start with 120 coins, enough for a second post straight away.

## Asset licence (important)

PostApocalypse_AssetPack_v1.1.2 by TheLazyStone: free for **non-commercial** use, **no redistribution**. Keep this repo private (don't push it to a public GitHub repo or share zips of it), and if the fest is commercial or sponsored, pay the $2 commercial licence. Credit is in the game footer.

## Phase log

- **Phase 1** (core loop): done. Login, fixed base, posts/walls/Main Tower upgrades, live + offline zombie waves, coins, persistence, reconnect.
- **Phase 2** (open world + PvP): shared map, graveyards, raids in place, spectating, minimap, leaderboard, live-battle list, event feed. Not yet: matchmaking "next target" list (the leaderboard big screen came in phase 4).
- **Phase 4** (spectating): Live Arena page, spectator connections, scoreboard and result cards, projector mode with auto-cycling and the big-screen leaderboard, rank-change feed items.
- **Phase 3** (immunity + crates): immunity purchase, the global crate race with rarities, attack/defence/loot boosts applied in combat and loot, 30-question bank.
