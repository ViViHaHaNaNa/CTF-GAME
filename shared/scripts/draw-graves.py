"""Usage: python shared/scripts/draw-graves.py <repo root> <preview.png>
Draw 4 small 16x16 grave sprites in the PostApocalypse pack's palette.
Writes client/public/game-assets/graveyard/grave_1..4.png (replace these files to change the art)."""
from PIL import Image
from collections import Counter
import os, sys

root = sys.argv[1]
pack = os.path.join(root, 'client/public/game-assets/postapocalypse')
out = os.path.join(root, 'client/public/game-assets/graveyard')
os.makedirs(out, exist_ok=True)

def palette(path, n=6):
    im = Image.open(os.path.join(pack, path)).convert('RGBA')
    c = Counter(p[:3] for p in im.getdata() if p[3] > 0)
    cols = [k for k, _ in c.most_common(n)]
    return sorted(cols, key=lambda k: sum(k))  # dark -> light

stone = palette('Objects/Gray-brick.png', 5)
wood = palette('Objects/Buildable/Wooden/Wooden-wall_Horizontal.png', 5)
ink = stone[0]
print('stone', stone, 'wood', wood)

def sprite(rows, colors):
    im = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch != '.':
                im.putpixel((x, y), colors[ch] + (255,))
    return im

S = {'o': ink, 'd': stone[1], 'm': stone[2], 'l': stone[3], 'h': stone[-1], 'w': wood[1], 'W': wood[3], 'k': wood[0], 'e': (58, 44, 38), 'E': (78, 60, 48)}

graves = [
    # 1: rounded headstone
    ['................',
     '................',
     '.....oooooo.....',
     '....ohhllmmo....',
     '...ohlllmmmdo...',
     '...olllmmmmdo...',
     '...olodddomdo...',
     '...ollllmmmdo...',
     '...olodddomdo...',
     '...ollmmmmmdo...',
     '...olmmmmmddo...',
     '...olmmmmmddo...',
     '..ooooooooooooo.',
     '..oeEEEEEEEEeeo.',
     '...oooooooooooo.',
     '................'],
    # 2: wooden cross
    ['................',
     '.......ooo......',
     '.......oWo......',
     '.......oWo......',
     '....oooowooooo..',
     '....oWWWWwwwwo..',
     '....oooowooooo..',
     '.......oWo......',
     '.......oWo......',
     '.......owo......',
     '.......owo......',
     '.......owo......',
     '.....oooooooo...',
     '....oeEEEEEeeo..',
     '.....ooooooooo..',
     '................'],
    # 3: tilted, cracked slab
    ['................',
     '................',
     '................',
     '......oooo......',
     '.....ohllmo.....',
     '....ohllmmdo....',
     '....olllomdo....',
     '...ohllomdo.....',
     '...olllomdo.....',
     '..ohllmmdo......',
     '..ollmmmdo......',
     '..olmmmddo......',
     '.oooooooooooo...',
     '.oeEEEEEEeeo....',
     '..oooooooooo....',
     '................'],
    # 4: small stone + fresh dirt mound
    ['................',
     '................',
     '................',
     '................',
     '................',
     '......oooo......',
     '.....ohlmdo.....',
     '.....olmmdo.....',
     '.....olmmdo.....',
     '...oooooooooo...',
     '..oeEEEEEEEEeo..',
     '.oeEEeEEEeEEEeo.',
     '.oEEEEEeEEEEEEo.',
     '.oeeEEEEEEEEeeo.',
     '..oooooooooooo..',
     '................'],
]
for i, rows in enumerate(graves, start=1):
    sprite(rows, S).save(os.path.join(out, f'grave_{i}.png'))
    # also a 4x preview strip for checking
big = Image.new('RGBA', (16 * 4 * 6, 16 * 6), (92, 80, 70, 255))
for i in range(4):
    g = Image.open(os.path.join(out, f'grave_{i + 1}.png')).resize((96, 96), Image.NEAREST)
    big.alpha_composite(g, (i * 96, 0))
big.save(sys.argv[2])
print('ok')
