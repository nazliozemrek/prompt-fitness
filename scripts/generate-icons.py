#!/usr/bin/env python3
"""
Regenerates all raster icons and splash sources from one vector-like drawing.
Requires Pillow:  pip install pillow
Outputs:
  assets/icon-only.png (1024, opaque), icon-foreground.png, icon-background.png,
  assets/splash.png, splash-dark.png (2732)          -> consumed by `npm run assets`
  extension/icons/icon-*.png, toolbar-*.png           -> browser extensions
  web/favicon.png                                     -> dashboard
  store/google/play-icon-512.png, feature-graphic-1024x500.png
"""
import math, os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = (6, 10, 16)
MINT = (78, 240, 168)
AQUA = (61, 216, 245)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def droplet_mask(size, scale=0.62):
    """Teardrop with a leaf in negative space, drawn at 4x and downsampled for smooth edges."""
    s = size * 4
    k = scale / 0.62
    m = Image.new('L', (s, s), 0)
    d = ImageDraw.Draw(m)
    cx, cy = s / 2, s / 2 + s * 0.02 * k
    rx, ry = s * 0.30 * k, s * 0.38 * k
    pts = []
    for i in range(720):
        t = 2 * math.pi * i / 720
        x = cx + rx * math.sin(t) * (math.sin(t / 2) ** 1.25)
        y = cy - ry * math.cos(t)          # point at the top
        pts.append((x, y))
    d.polygon(pts, fill=255)

    # Leaf: lens = intersection of two circles, rotated, cut out of the drop.
    lx, ly = cx, cy + ry * 0.22
    R, off = rx * 0.62, rx * 0.40
    a = Image.new('L', (s, s), 0); ImageDraw.Draw(a).ellipse([lx - off - R, ly - R, lx - off + R, ly + R], fill=255)
    b = Image.new('L', (s, s), 0); ImageDraw.Draw(b).ellipse([lx + off - R, ly - R, lx + off + R, ly + R], fill=255)
    from PIL import ImageChops
    lens = ImageChops.multiply(a, b).rotate(-40, center=(lx, ly), resample=Image.BICUBIC)
    m = ImageChops.subtract(m, lens)
    # Midrib: restore a thin line of the drop through the leaf.
    rib = Image.new('L', (s, s), 0)
    L = R * 0.95
    ang = math.radians(-40 + 90)
    ImageDraw.Draw(rib).line(
        [(lx - L * math.cos(ang) * 0.8, ly + L * math.sin(ang) * 0.8), (lx + L * math.cos(ang) * 0.8, ly - L * math.sin(ang) * 0.8)],
        fill=255, width=max(1, int(rx * 0.05)))
    rib = ImageChops.multiply(rib, lens)
    m = ImageChops.add(m, rib)
    return m.resize((size, size), Image.LANCZOS)

def gradient(size):
    g = Image.new('RGB', (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = min(1, max(0, (x + y) / (2 * size)))
            px[x, y] = lerp(MINT, AQUA, t)
    return g

def mark(size, scale=0.62):
    """RGBA droplet mark on transparent background."""
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(gradient(size), (0, 0), droplet_mask(size, scale))
    return out

def with_bg(img, size, glow=True):
    base = Image.new('RGB', (size, size), BG)
    if glow:
        g = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(g)
        gd.ellipse([size * .18, size * .18, size * .82, size * .82], fill=(78, 240, 168, 38))
        g = g.filter(ImageFilter.GaussianBlur(size * .08))
        base.paste(g, (0, 0), g)
    base.paste(img, (0, 0), img)
    return base

def save(img, *path):
    p = os.path.join(ROOT, *path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.save(p, optimize=True)

# --- Capacitor asset sources ---
master = mark(1024)
save(with_bg(master, 1024), 'assets', 'icon-only.png')                     # opaque (App Store forbids alpha)
save(mark(1024, scale=0.46), 'assets', 'icon-foreground.png')               # inside adaptive 66% safe zone
save(Image.new('RGB', (1024, 1024), BG), 'assets', 'icon-background.png')
splash = Image.new('RGB', (2732, 2732), BG)
sm = mark(900, scale=0.62)
splash.paste(sm, ((2732 - 900) // 2, (2732 - 900) // 2), sm)
save(splash, 'assets', 'splash.png')
save(splash, 'assets', 'splash-dark.png')

# --- Extension icons (transparent corners, rounded tile) ---
def tile(size):
    t = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mask = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius=size * 4 * 0.22, fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    t.paste(with_bg(mark(size), size, glow=size >= 48).convert('RGBA'), (0, 0), mask)
    return t

for s in (16, 32, 48, 96, 128, 256, 512):
    save(tile(s), 'extension', 'icons', f'icon-{s}.png')
for s in (16, 19, 32, 38):
    save(mark(s, scale=0.8), 'extension', 'icons', f'toolbar-{s}.png')

save(tile(64), 'web', 'favicon.png')

# --- Play Store listing assets ---
save(with_bg(mark(512), 512), 'store', 'google', 'play-icon-512.png')
fg = Image.new('RGB', (1024, 500), BG)
glow = Image.new('RGBA', (1024, 500), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse([80, -40, 620, 540], fill=(78, 240, 168, 30))
glow = glow.filter(ImageFilter.GaussianBlur(60))
fg.paste(glow, (0, 0), glow)
m2 = mark(360)
fg.paste(m2, (170, 70), m2)
save(fg, 'store', 'google', 'feature-graphic-1024x500.png')
print('✓ icons, splash sources and store graphics generated')
