"""Humbler app icon: a coral box (a bundle) with a keyhole, on a dark tile.
Drawn at 4x and downscaled for smooth edges. Writes resources/icon.png (1024),
resources/icon.ico (16-256) and a preview strip to the scratchpad."""
import os
import sys
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "")
OUT_PREVIEW = sys.argv[1] if len(sys.argv) > 1 else ROOT + "resources/icon-preview.png"
S = 4096  # draw size
u = S / 1024  # 1 unit = 1px of the 1024 icon

BG_TOP = (42, 44, 51)
BG_BOT = (22, 23, 27)
CORAL = (229, 83, 61)
CORAL_DARK = (184, 58, 41)
CORAL_LIGHT = (240, 120, 98)
HOLE = (22, 23, 27)

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# tile: rounded square with a vertical gradient
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    gd.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT)) + (255,))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40 * u, 40 * u, 984 * u, 984 * u], radius=210 * u, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
P = lambda *pts: [(x * u, y * u) for x, y in pts]

# box body (front face)
d.rounded_rectangle([232 * u, 430 * u, 792 * u, 830 * u], radius=44 * u, fill=CORAL)
# lid, slightly wider, lighter on top
d.rounded_rectangle([196 * u, 300 * u, 828 * u, 440 * u], radius=40 * u, fill=CORAL_LIGHT)
# shadow line under the lid
d.rectangle([232 * u, 440 * u, 792 * u, 468 * u], fill=CORAL_DARK)

# keyhole on the front
cx, cy = 512, 600
d.ellipse([(cx - 62) * u, (cy - 62) * u, (cx + 62) * u, (cy + 62) * u], fill=HOLE)
d.polygon(P((cx - 34, cy + 20), (cx + 34, cy + 20), (cx + 58, cy + 160), (cx - 58, cy + 160)), fill=HOLE)

big = img.resize((1024, 1024), Image.LANCZOS)
os.makedirs(ROOT + "resources", exist_ok=True)
big.save(ROOT + "resources/icon.png")
big.save(ROOT + "resources/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# preview: the sizes people actually see, on dark and light
sizes = [16, 24, 32, 48, 64, 128, 256]
W = sum(sizes) + 20 * (len(sizes) + 1)
strip = Image.new("RGBA", (W, 2 * 276 + 20), (255, 255, 255, 255))
ImageDraw.Draw(strip).rectangle([0, 0, W, 286], fill=(32, 33, 38, 255))
x = 20
for s in sizes:
    small = img.resize((s, s), Image.LANCZOS)
    strip.paste(small, (x, 20 + 256 - s), small)
    strip.paste(small, (x, 306 + 256 - s), small)
    x += s + 20
strip.save(OUT_PREVIEW)
print("ok")
