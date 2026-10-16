# Bundled fonts

The game loads its fonts from this folder (see `@font-face` in `client/src/theme.css`), so it never needs
the internet. All three are under the SIL Open Font Licence (the `OFL-*.txt` files here); they were taken
unmodified from the Fontsource packages (Latin subset).

| File | Font | Used for (theme variable) |
|---|---|---|
| `press-start-2p-latin-400-normal.woff2` | Press Start 2P | logo, menus, headings, buttons (`--font-display`) |
| `pixelify-sans-latin-400-normal.woff2`, `-700-` | Pixelify Sans | body text, map name tags (`--font`) |
| `vt323-latin-400-normal.woff2` | VT323 | numbers, code, counters (`--font-mono`) |

To swap a font, replace the file and its `@font-face` `src` in `theme.css`.
