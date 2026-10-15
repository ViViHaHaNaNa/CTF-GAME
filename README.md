# Code Siege

The IETE-SF fest game: an apocalyptic base-defence + PvP game played on phones over the venue wifi,
with a Live Arena for the projector. Everything (website, game server, database) runs on one laptop.

- Players: `http://<laptop IP>:3000/siege/`
- Live Arena (watch only, no login): `/siege/arena/`
- Projector: `/siege/arena/?projector=1`, then press **Fullscreen**
- Organisers: `/siege/admin/` (passphrase)

Design notes and decisions are in [NOTES.md](NOTES.md).

## Run it

Needs **Node.js 22** (https://nodejs.org). The first install needs internet; after that it runs offline.

```bash
npm install
```

Set the admin passphrase: copy `server/.env.example` to `server/.env` and fill in `SIEGE_ADMIN_PASS`
(no passphrase = the admin page is off).

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

For development: `npm run dev` (hot reload; the site is on port 5173), `npm test`, `npm run typecheck`.

### Settings

In `server/.env` or as environment variables (real environment variables win):

| Setting | Default | |
|---|---|---|
| `SIEGE_ADMIN_PASS` | (empty: admin off) | passphrase for `/siege/admin/` |
| `SIEGE_PORT` | `3000` | |
| `SIEGE_HOST` | `0.0.0.0` | `0.0.0.0` = reachable from the network |
| `SIEGE_DB` | `server/data/siege.db` | the whole game state |
| `SIEGE_BACKUPS` | `server/data/backups` | where backups go |
| `SIEGE_QUESTIONS` | `server/data/questions.json` | crate questions |

Game balance (costs, damage, wave sizes, crate timing, boosts...) is all in `shared/src/config.ts`.
To host the game server somewhere else later, see the cloud note in NOTES.md.

## Admin page

`/siege/admin/`, with the passphrase. Five wrong passphrases in a minute lock that device out for a minute.

- **Pause / resume** the game: no waves, raids or crates, and players can't act (they see a banner). Shields,
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

**Fresh start for the fest** (wipes everyone): stop the server, back up, delete `server/data/siege.db*`, start.
Or delete just the test accounts from the admin page.

## Event-day checklist

**The day before**

- [ ] `npm install` done on the event laptop while you have internet; `npm start` works.
- [ ] `server/.env` has a strong `SIEGE_ADMIN_PASS`, known to the organisers only.
- [ ] Test accounts deleted (admin page) or a fresh database.
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
`client/public/game-assets/graveyard/` are our own.
