"""Usage: python shared/scripts/draw-vault.py <repo root> [preview.png]
Draw the vault (a steel strongbox on a pallet, with coins) in the PostApocalypse pack's palette:
client/public/game-assets/vault/vault.png (intact) and vault_broken.png (cracked open), 32x26 each.
The pack has no safe or vault, so this is our own art; replace these files freely."""
from PIL import Image
from collections import Counter
import os, sys

root = sys.argv[1]
pack = os.path.join(root, 'client/public/game-assets/postapocalypse')
out = os.path.join(root, 'client/public/game-assets/vault')
os.makedirs(out, exist_ok=True)


def palette(path, n=6):
    im = Image.open(os.path.join(pack, path)).convert('RGBA')
    c = Counter(p[:3] for p in im.getdata() if p[3] > 0)
    return sorted([k for k, _ in c.most_common(n)], key=lambda k: sum(k))  # dark -> light


def ramp(cols, n=6):
    # Spread the source's darkest..lightest colours over n even steps.
    a, b = cols[0], cols[-1]
    return [tuple(round(a[i] + (b[i] - a[i]) * k / (n - 1)) for i in range(3)) for k in range(n)]


steel = ramp(palette('Objects/Container/Container_3_Gray_Horizontal.png', 8))
wood = palette('Objects/Pallet_1.png', 4)
ink = (24, 20, 28)
gold = [(122, 78, 18), (196, 138, 30), (246, 196, 60), (255, 236, 150)]
W, H = 32, 26


def px(im, x, y, c):
    if 0 <= x < W and 0 <= y < H:
        im.putpixel((x, y), c + (255,))


def rect(im, x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            px(im, x, y, c)


def coin(im, x, y):
    rect(im, x, y, x + 2, y + 1, gold[2])
    px(im, x + 1, y, gold[3])
    px(im, x, y + 1, gold[1])
    px(im, x + 2, y + 1, gold[1])


def base_pallet(im):
    # Wooden pallet under the box.
    rect(im, 2, 21, 29, 24, ink)
    rect(im, 3, 22, 28, 23, wood[1])
    for x in range(4, 28, 6):
        rect(im, x, 22, x + 3, 22, wood[2])


def vault(broken=False):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    base_pallet(im)
    # Body: outlined steel box with a bevel.
    rect(im, 4, 4, 27, 21, ink)
    rect(im, 5, 5, 26, 20, steel[2])
    rect(im, 5, 5, 26, 6, steel[4])
    rect(im, 5, 19, 26, 20, steel[1])
    rect(im, 25, 7, 26, 18, steel[1])
    for x, y in [(6, 7), (24, 7), (6, 17), (24, 17)]:
        px(im, x, y, steel[5])  # rivets
    if not broken:
        # Door seam, round dial and a handle.
        rect(im, 8, 8, 23, 18, steel[3])
        rect(im, 8, 8, 23, 8, steel[4])
        rect(im, 8, 18, 23, 18, steel[1])
        rect(im, 12, 10, 16, 15, ink)
        rect(im, 13, 11, 15, 14, steel[5])
        px(im, 14, 11, ink)
        px(im, 14, 12, steel[1])
        rect(im, 19, 11, 20, 15, ink)
        rect(im, 19, 12, 20, 14, gold[2])
        # Coins stacked on top.
        for x, y in [(8, 2), (11, 1), (14, 2), (18, 2), (21, 1)]:
            coin(im, x, y)
    else:
        # Door torn open: dark, scorched inside, door hanging off, coins spilled.
        rect(im, 8, 8, 23, 18, ink)
        rect(im, 9, 9, 22, 17, (40, 30, 34))
        for x, y in [(10, 15), (13, 16), (17, 15), (20, 16)]:
            coin(im, x, y)
        rect(im, 0, 10, 6, 19, ink)
        rect(im, 1, 11, 5, 18, steel[3])
        px(im, 3, 14, steel[5])
        for x, y in [(26, 22), (29, 23), (1, 22)]:
            coin(im, x, y)
        for x, y in [(9, 3), (16, 2), (23, 4)]:
            px(im, x, y, steel[1])  # smoke specks
    return im


a = vault(False)
b = vault(True)
a.save(os.path.join(out, 'vault.png'))
b.save(os.path.join(out, 'vault_broken.png'))
if len(sys.argv) > 2:
    p = Image.new('RGBA', (W * 2 + 6, H), (60, 60, 80, 255))
    p.alpha_composite(a, (0, 0))
    p.alpha_composite(b, (W + 6, 0))
    p.resize((p.width * 8, p.height * 8), Image.NEAREST).save(sys.argv[2])
print('steel', steel, 'wood', wood)
