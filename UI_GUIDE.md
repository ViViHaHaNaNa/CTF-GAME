# UI guide (for the redesign)

You can change how Code Siege **looks and is laid out** without touching how it **plays**. This page says
which files are yours, which to leave alone, and how to check your work. Setup and running: [README.md](README.md).

## The golden rule

**Don't edit the server, the combat engine, the balance config or the networking code.** They're the game
itself: a change there can break the game for every player (and the tests). If a design needs something they
don't offer yet (a new number shown, a new event), ask a developer to expose it.

Not yours (leave alone):

| Path | What it is |
|---|---|
| `server/` (all of it) | the game server, accounts, raids, crates, admin, database |
| `shared/src/engine.ts` | the combat engine (units, posts, damage, movement) |
| `shared/src/config.ts` | **all balance numbers** (costs, damage, surges, timings) |
| `shared/src/pve.ts`, `pvp.ts`, `economy.ts`, `powers.ts`, `crates.ts` | game rules (zombie surges, raids, upgrades, powers, crates) |
| `shared/src/world.ts`, `layout.ts` | the city map and base layout (tiles) |
| `shared/src/snapcodec.ts`, `types.ts` | the network data format |
| `client/src/siege/net.ts`, `stream.ts` | talking to the server |
| `client/vite.config.ts`, `package.json`, `.env.example` | build and settings |

Everything under `shared/` and `server/` is game logic. Everything below is presentation.

## Yours: look and feel

| File | What's in it |
|---|---|
| `client/src/theme.css` | **The theme: every colour, font, size, radius, shadow and spacing token**, for the pages *and* the map (the `--map-*` tokens are read by the canvas renderer). Start here. |
| `client/src/siege/siege.css` | The game page: layout zones and every component (top bar, banner, map buttons, action rail, panels, toasts, dialogs). Only layout here; values come from the theme. |
| `client/src/siege/arena.css` | The Live Arena / projector page. |
| `client/src/siege/admin.css` | The organisers' admin page. |
| `client/src/site.css` | The home page (`/`) and page basics. |
| `client/siege/index.html`, `client/siege/arena/index.html`, `client/siege/admin/index.html` | Page markup (see "Hooks" below before renaming anything). |
| `client/src/siege/copy.ts` | **Wording and icons**: names of posts, raiders, weapons and powers, power icons and descriptions, the checklist, the walkthrough prompts. |
| `client/public/fonts/` | Font files (licences included). Fonts are wired up in `theme.css` (`@font-face`, `--font*`). |
| `client/public/game-assets/` | The art pack (licence: non-commercial, don't redistribute; see the README). |
| `client/src/siege/sprites.ts` | Which sprite sheet is used for what. |
| `client/src/siege/theme.ts` | Reads the theme tokens for the canvas (add a line here when you add a new `--map-*` token the map should use). |

Shared presentation code (careful: look and layout only):

| File | What's in it |
|---|---|
| `client/src/siege/world.ts` | Draws the map (bases, units, effects) on the canvas. Colours come from the theme. Change *how things look*, not what happens. |
| `client/src/siege/main.ts` | The game page's UI: fills in the HUD, builds the panel cards (HTML templates), shows toasts and banners, and sends player actions. You can change the panel markup and how things are presented; keep the actions it sends (`net.*` calls) and the ids below. |
| `client/src/siege/title.ts`, `titleScene.ts`, `retro.ts` | The arcade title screen, its animated scene, and the pixel font + sound effects. |
| `client/src/siege/arena.ts`, `admin.ts` | The Live Arena and admin page UI. |

### How the theme reaches the map

The map is a canvas, so it can't use CSS directly. `theme.ts` reads the CSS custom properties from
`theme.css` once at start (`THEME.*`) and the renderer uses those. So **change map colours in theme.css**,
never in `world.ts`. Tokens that are drawn semi-transparent are written as `R, G, B` triples (for example
`--map-cmd-strike: 255, 60, 40;`).

### Layout zones (game page)

`siege.css` describes the zones at the top. In short: top bar, banner row, then the map viewport with
**one grid over it** (`.hud-layer`) whose named areas hold the map buttons (`tools`), minimap and zoom
(`corner`), objectives (`notes`), the news feed (`feed`), the walkthrough prompt (`coach`), the action rail
(`rail`) and the empty middle (`free`). The camera frames the player's base inside `free`, so keep
`#hud-free` in the grid and keep things out of it (toasts are the exception: they queue there). Phones get
their own grid layouts at the bottom of the file.

Rules the layout keeps (please keep them): text never under 12px (`--ui-2xs`, `--ui-xs`), touch targets at
least 44px (`--hit`), no sideways page scroll, phone safe areas respected, one z-index scale (`--z-*`).

## Hooks: keep these ids and attributes

The code finds elements by id, so you can restyle, move and re-wrap them freely, but **keep the ids**
(and the `data-*` attributes on buttons the code creates).

- Game page: `app`, `hud`, `hud-name`, `hud-hq`, `hud-chips`, `hud-coins`, `hud-coins-box`, `hud-trophies`,
  `hud-trophies-box`, `hud-delta`, `sound-btn`, `menu-btn`, `banner-row`, `wave-banner`, `mode-toggle`
  (buttons with `data-mode="pve"` / `"pvp"`), `mode-cd`, `pause-btn`, `board-wrap`, `board`, `hurt`,
  `hud-free`, `toasts`, `map-tools`, `home-btn`, `ranks-btn`, `live-btn`, `live-count`, `crate-btn`,
  `crate-badge`, `minimap`, `zoom-in`, `zoom-out`, `objectives`, `objectives-head`, `objectives-count`,
  `objectives-list`, `feed`, `coach`, `cmd-bar`, `combo`, `threat`, `threat-def`, `threat-next`,
  `threat-word`, `early-btn`, `early-sub`, `ammo`, `ammo-name`, `rounds`, `reload-fill`, `strike-btn`,
  `molotov-btn`, `squad-btn`, `squad-hp`, `ult-btn` (and the `*-cd` spans inside them), `attack-bar`,
  `raid-title`, `raid-stars`, `raid-dmg`, `raid-army`, `retreat-btn`, `troops`, `panel`, `unlock`, `menu`,
  `logout-btn`, `close-menu`, `title`, `connecting`.
- Buttons the code makes inside panels use `data-act`, `data-attack`, `data-spectate`, `data-immunity`,
  `data-jump`, `data-troop`, `data-squad`, `data-close`, `data-sheet`, `data-crate-jump`, `data-until`.
- Live Arena: `board-wrap`, `scoreboard`, `sb-att`, `sb-def`, `sb-fill`, `sb-dmg`, `sb-stars`, `sb-troops`,
  `result`, `idle`, `cycle`, `battles`, `org-status`, `projector-btn`, `fullscreen-btn`, `connecting`.
- Admin: `login`, `login-form`, `login-error`, `main`, `game-state`, `pause-btn`, `board-state`,
  `freeze-btn`, `backup-btn`, `players`, `player-count`, `search`, `sync`, `logout`, `toasts`.

Class names are yours to change, except the state classes the code toggles (`hidden` attribute,
`.on`, `.cooling`, `.aiming`, `.out`, `.attack`, `.alarm`, `.held`, `.paused`, `.collapsed`, `.closed`,
`.show`, `.bump`, `.pulse`, `.flash`, `.reloading`, `.dragging`, `.aim`, `.strike-aim`, `.deploying`,
`.raiding`, `.sheet-open`, `.safe`/`.close`/`.danger` on the threat meter): restyle them, but keep the names.

## Trying your design

1. `npm run dev` with `DEV_MODE=true` in `.env` (see the README), then open http://localhost:5173/siege/.
2. Log in as the bots to see every stage of the game without playing for hours. Display name / roll number:
   **Bot Lv1 / BOT01** up to **Bot Lv8 / BOT08** (one per Main Tower level; Lv3 has a boost, Lv4 is immune,
   Lv5 is paused, Lv2/4/6/8 are in Raid mode). Make two or three accounts of your own as well (each in its own
   browser window or private window) to try raids.
3. Check phones: open the Wi-Fi address that `npm run dev` prints on your phone, or use your browser's device
   toolbar (portrait 390x844 and landscape 844x390).
4. `npm run ui-audit` screenshots 17 screens at 5 sizes and lists anything that overlaps, gets cut off, is
   too small to read or too small to tap (`layout-audit/latest/report.md`, images next to it; `layout-audit/before` and `after` are the redesign-prep baseline). Aim for 0.
5. `npm test` must still pass (it doesn't test looks, but it catches a broken build).

**DEV_MODE is for development only.** It must be `false` for the real event; `npm start` (the event build)
ignores it and won't start while bot accounts exist.
