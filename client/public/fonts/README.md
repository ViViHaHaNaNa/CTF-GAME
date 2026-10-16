# Bundled fonts

The game loads its fonts from this folder (see `@font-face` in `client/src/theme.css`), so it never needs
the internet. Put two open-licence `.woff2` files here:

- `siege-sans.woff2`: the UI and map label font (a variable or bold-capable sans)
- `siege-mono.woff2`: numbers, code and the HUD counters

Keep the font's licence file next to it. Until the files exist, the system font fallbacks in `--font` and
`--font-mono` are used.
