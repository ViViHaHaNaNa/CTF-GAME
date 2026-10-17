# Code Siege

The IETE-SF fest game: an apocalyptic base-defence + PvP game played on phones over the venue wifi,
with a Live Arena for the projector. The website, game server and database all run on one computer.

- **Designers:** read [UI_GUIDE.md](UI_GUIDE.md) (which files are yours, which to leave alone).
- Design notes and the reasons behind the rules: [NOTES.md](NOTES.md).

> **Keep this repository private.** The art is the
> [Post-Apocalypse asset pack](https://thelazystone.itch.io/post-apocalyptic-pixel-art-asset-pack) by
> TheLazyStone: free for **non-commercial** use only and **not** to be redistributed. Don't publish the repo,
> fork it publicly or upload the art anywhere. (Grave sprites in `client/public/game-assets/graveyard/` are ours.)

## Quick start (your own laptop)

You need **Git** and **Node.js 22** (the version is pinned in `.nvmrc`). The first install needs internet;
after that everything runs offline.

### Windows

1. Install Git: https://git-scm.com/download/win (defaults are fine).
2. Install Node.js **22 LTS**: https://nodejs.org (the Windows installer, defaults are fine). Already have
   another Node version? Use [nvm-windows](https://github.com/coreybutler/nvm-windows): `nvm install 22` then `nvm use 22`.
3. Open **PowerShell** (or Git Bash) and run:

   ```bash
   git clone <the private repo URL> code-siege
   cd code-siege
   node -v
   ```

   `node -v` must print `v22.something`.
4. Then the same steps as on a Mac, from **Install** below.

If Git complains about long file names while cloning, run `git config --global core.longpaths true` once and clone again.

### Mac

1. Install Git (it comes with Xcode's command line tools: run `xcode-select --install` in Terminal) and
   Node.js 22, either from https://nodejs.org or with nvm (https://github.com/nvm-sh/nvm):
2. In Terminal:

   ```bash
   git clone <the private repo URL> code-siege
   cd code-siege
   nvm install     # reads .nvmrc (skip this line if you installed Node from nodejs.org)
   node -v
   ```

### Install, settings, start (Windows and Mac)

```bash
npm install
```

Copy the settings file and turn on development mode (the bot accounts):

```bash
cp .env.example .env
```

(In Windows PowerShell: `copy .env.example .env`.) Open `.env` and set `DEV_MODE=true`. Every setting in it
is explained there and has a safe default.

Now **one command starts everything** (the game server and the website, with hot reload):

```bash
npm run dev
```

Open **http://localhost:5173/siege/** and log in (any display name + roll number, see below). Stop with `Ctrl+C`.
Save a CSS or TS file under `client/` and the page updates by itself.

Other pages: Live Arena `/siege/arena/` (watch only), projector `/siege/arena/?projector=1`,
admin `/siege/admin/` (needs `SIEGE_ADMIN_PASS` in `.env`).

### Open it on your phone (same wifi)

`npm run dev` prints addresses like:

```
  LAN:         http://192.168.1.23:5173/siege/   (Wi-Fi)
```

Open that **Wi-Fi** address on a phone connected to the same wifi (never one marked "virtual").
- Windows asks "Allow Node.js?" the first time: allow it on **private networks**.
- Mac may ask whether to accept incoming connections for `node`: allow it.
- Still not loading? Some networks (college wifi, guest networks) block devices from reaching each other.
  Use a phone hotspot or a home router instead.

## Accounts, test players and bots

**A fresh copy starts with an empty world.** Accounts live only in your own database
(`server/data/siege.db`, never committed), so nobody else sees your test players and you can't see theirs.

**Make your own test accounts:** on the title screen choose Start game and enter any display name and roll
number (4-15 letters/digits). Each account needs a **different display name and roll number**, and each
needs its own browser session: a normal window, a private/incognito window, another browser, or your phone.
Logging in again later with the same name + roll number gets the same account back.

Raids need other players, so **three or more accounts** are useful (or use the bots below).

### Bot accounts (DEV_MODE)

With `DEV_MODE=true` in `.env`, starting on an empty database creates **8 bot accounts**, one per Main Tower
level, and a crate is waiting to be claimed:

| Display name | Roll number | Main Tower | What's special |
|---|---|---|---|
| Bot Lv1 | BOT01 | 1 | Grind; still building the basic base (objectives checklist shows) |
| Bot Lv2 | BOT02 | 2 | Raid mode |
| Bot Lv3 | BOT03 | 3 | Grind; an active attack boost; Gun and Airstrike unlocked |
| Bot Lv4 | BOT04 | 4 | Raid mode; immune to raids (shield chip) |
| Bot Lv5 | BOT05 | 5 | Grind; surges **paused** (pause chip on the map); Shotgun and Molotov |
| Bot Lv6 | BOT06 | 6 | Raid mode |
| Bot Lv7 | BOT07 | 7 | Grind; Squad member unlocked |
| Bot Lv8 | BOT08 | 8 | Raid mode; Carpet bomb (the ultimate) unlocked |

Log in as any of them with the display name and roll number above (exactly as written). Each is fully built
for its level (posts, walls, Commander weapon, abilities and raider troops for that level) with most of a vault
of coins to try upgrades, and different trophy counts so the leaderboard has a spread.

Nobody plays them: they behave like offline players. They can be raided and spectated, they're on the
leaderboard, and their zombie surges run in the background. (Bots in Raid mode, and the paused one, have
no surges, like real players in those states.)

- `npm run bots` recreates all 8 fresh (and drops a crate). `npm run bots -- --remove` deletes them.
- `npm run reset` wipes the whole world (every account, bots included), after backing it up.
- Both need the server stopped first (`Ctrl+C` in its terminal): the server keeps the world in memory.

**DEV_MODE must be off for the real event.** The event is started with `npm start`, which ignores
`DEV_MODE` and refuses to start if the database still has bot accounts, so no bot can appear on the
leaderboard in front of real players.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development: game server + website with hot reload (http://localhost:5173/siege/) |
| `npm start` | **The event**: builds the site and serves everything on port 3000 (`DEV_MODE` ignored) |
| `npm run bots` | Recreate the 8 bot accounts (`-- --remove` to delete them). Server stopped. |
| `npm run reset` | Empty world: backs up, then deletes the database. Server stopped. |
| `npm run backup` | Back up the database (safe while running) to `server/data/backups/` |
| `npm test` / `npm run typecheck` | Tests / type checks |
| `npm run ui-audit` | Screenshots every screen at 5 sizes and reports overlapping or clipped UI (`layout-audit/`) |
| `npm run loadtest` | 50 bot players against a throwaway server (the real database is untouched) |

## Settings

All in `.env` at the repo root (copy `.env.example`; real environment variables win; an older
`server/.env` is still read). Never commit `.env`.

| Setting | Default | |
|---|---|---|
| `DEV_MODE` | `false` | bots + a waiting crate on an empty world. **Off for the event.** |
| `SIEGE_ADMIN_PASS` | (empty: admin off) | passphrase for `/siege/admin/` |
| `SIEGE_PORT` | `3000` | game server (and the whole site with `npm start`) |
| `SIEGE_HOST` | `0.0.0.0` | `0.0.0.0` = reachable from phones; `127.0.0.1` = this computer only |
| `SIEGE_DEV_PORT` | `5173` | the website during `npm run dev` |
| `VITE_SIEGE_SERVER_URL` | (empty) | only if the game server runs on another machine |
| `SIEGE_DB` | `server/data/siege.db` | the whole game state |
| `SIEGE_BACKUPS` | `server/data/backups` | |
| `SIEGE_QUESTIONS` | `server/data/questions.json` | crate questions |

Game balance (costs, damage, surges, crates, boosts) is all in `shared/src/config.ts`: not a designer file.

## Running the event

```bash
npm start
```

This builds the site and starts one server on port 3000. It prints the addresses to use, for example:

```
  Code Siege game server on port 3000 (0 players, 30 crate questions)
  This laptop: http://localhost:3000/siege/
  LAN:         http://192.168.29.97:3000/siege/   (Wi-Fi)
  LAN:         http://172.22.96.1:3000/siege/   (vEthernet (WSL), virtual: phones cannot use this)
```

Give players the **Wi-Fi** (or Ethernet) address, never one marked virtual. Stop with `Ctrl+C`. Everything is
saved as it happens, so restarting loses nothing except raids that were in progress at that moment.

## Admin page

`/siege/admin/`, with the passphrase. Five wrong passphrases in a minute lock that device out for a minute.

- **Pause / resume** the game: no zombie sieges, raids or crates, and players can't act (they see a banner). Shields,
  immunity and the crate timer are pushed back by the length of the pause.
- **Freeze / unfreeze the leaderboard**: everyone keeps seeing the standings from the moment you froze it
  (handy before announcing winners). Raids still count and appear when you unfreeze.
- **Drop a crate** now (random, or pick green / blue / red). It shows the accepted answers.
- **Reset a player** (fresh base, keeps their account and plot) or **delete** one (frees the plot; type their
  name to confirm). Not possible while they're in a raid.
- **Back up** the database, and server health: players online, tick time (must stay well under 50 ms),
  memory, errors.

## Load test

```bash
npm run loadtest
```

Starts its **own throwaway server and database** (the real game is untouched), connects 50 bot players and
3 spectators for 60 s: they log in, upgrade, raid each other, answer crates (several racing with the right
answer) and drop and reconnect. It ends with PASS/FAIL checks. Options: `-- --clients 60 --seconds 120`.

On the dev laptop (Oct 2026): p95 response 5 ms, ticks 1-4 ms of the 50 ms budget, 112 MB memory,
every crate exactly one winner. Real wifi adds its own delay on top; run it once on the event laptop.

## Backups and restore

```bash
npm run backup
```

Safe while the game is running. Writes `server/data/backups/siege-<date>_<time>.db` (local time) (the admin page has the
same button). To restore: stop the server, copy the backup over `server/data/siege.db`, delete
`siege.db-wal` and `siege.db-shm` next to it, start again.

**Fresh start for the fest** (wipes everyone, bots included): stop the server, `npm run reset` (it backs up
first), then `npm start`. Or delete just the test accounts from the admin page.

## Event-day checklist

**The day before**

- [ ] `npm install` done on the event laptop while you have internet; `npm start` works.
- [ ] `.env` has a strong `SIEGE_ADMIN_PASS`, known to the organisers only, and `DEV_MODE=false`.
- [ ] A fresh database (`npm run reset`) or test accounts deleted on the admin page. No bot accounts
      (`npm start` refuses to run while there are any: `npm run bots -- --remove`).
- [ ] `npm run loadtest` passes on this laptop.
- [ ] Windows Update paused for the fest days (Settings > Windows Update > Pause updates).

**Network** (the part most likely to go wrong)

- [ ] Use a router you control if at all possible (laptop on Ethernet to it, players on its wifi). College and
      venue wifi often has *client isolation*: phones can't reach other devices. Test this early with a phone.
- [ ] Fixed IP for the laptop, so the printed address and any QR codes stay valid: a DHCP reservation on the
      router, or a static IP in the Wi-Fi/Ethernet adapter settings.
- [ ] Firewall: allow port 3000 in. In PowerShell **as administrator**:

  ```powershell
  New-NetFirewallRule -DisplayName "Code Siege" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Any
  ```

  Windows may also pop up "Allow Node.js?" the first time: allow it on private **and** public networks.
- [ ] From a phone on the same wifi, open `http://<laptop IP>:3000/siege/` and log in.
- [ ] Put the address on posters / a QR code (any QR generator works offline-printable).

**The laptop**

- [ ] On the charger the whole time.
- [ ] Never sleeps, even with the lid closed. In PowerShell **as administrator**:

  ```powershell
  powercfg /change standby-timeout-ac 0
  powercfg /change hibernate-timeout-ac 0
  powercfg /change monitor-timeout-ac 0
  powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
  powercfg /setactive SCHEME_CURRENT
  ```

- [ ] Power mode "Best performance"; close other heavy apps.

**During the fest**

- [ ] `npm start` in a terminal you leave open. Note the Wi-Fi address it prints.
- [ ] Projector: a browser at `/siege/arena/?projector=1`, press Fullscreen.
- [ ] Admin page open on an organiser's phone or laptop. Glance at tick time and errors now and then.
- [ ] Back up every hour or so (`npm run backup` or the admin button), and before any restart.
- [ ] Before announcing results: freeze the leaderboard.

**If something goes wrong**

| Problem | Fix |
|---|---|
| Phones stuck on "Connecting..." or the page won't load | Same wifi? Using the Wi-Fi address (not a virtual one)? Firewall rule? Client isolation on the network (use your own router or a phone hotspot)? |
| `EADDRINUSE` on start | Something already uses port 3000: an older copy of the server is still running. Close it, or start with `SIEGE_PORT=3001`. |
| Server crashed or laptop rebooted | `npm start` again. Bases, coins, trophies and crates are all kept; players' pages reconnect by themselves. |
| A player can't log in ("registered under a different name") | Same roll number must use the same name. Fix by resetting or deleting that account from the admin page. |
| Need everyone to stop | Admin page > Pause. |

## Credits and licence

Art: [Post-Apocalypse asset pack](https://thelazystone.itch.io/post-apocalyptic-pixel-art-asset-pack) by
TheLazyStone. Free for **non-commercial** use and **not** for redistribution: keep this repo private, and buy
the commercial licence if the fest is commercial or sponsored. Grave sprites in
`client/public/game-assets/graveyard/` are our own. Fonts: see `client/public/fonts/README.md` (SIL OFL).
