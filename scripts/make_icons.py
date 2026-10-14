"""Generate PocketLedger PWA icons (PNG) into public/icons. Run: npm run icons"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
GREEN = (31, 111, 92)
PAPER = (246, 247, 249)
INK = (31, 111, 92)


def draw(size: int, maskable: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), GREEN if maskable else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = int(size * (0.2 if maskable else 0.06))
    if not maskable:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=GREEN)
    # receipt shape
    w = size - 2 * pad
    left, top = pad + int(w * 0.2), pad + int(w * 0.12)
    right, bottom = size - pad - int(w * 0.2), size - pad - int(w * 0.16)
    d.rectangle([left, top, right, bottom], fill=PAPER)
    teeth = 6
    tw = (right - left) / teeth
    for i in range(teeth):
        x0 = left + i * tw
        d.polygon([(x0, bottom), (x0 + tw / 2, bottom + tw * 0.6), (x0 + tw, bottom)], fill=PAPER)
    lh = max(2, int(size * 0.035))
    for i, frac in enumerate([0.75, 0.55, 0.65]):
        y = top + int((bottom - top) * (0.2 + i * 0.2))
        d.rectangle([left + int(w * 0.07), y, left + int((right - left) * frac), y + lh], fill=INK)
    y = top + int((bottom - top) * 0.8)
    d.rectangle([left + int((right - left) * 0.45), y, right - int(w * 0.07), y + lh * 2], fill=INK)
    return img


for name, size, mask in [("icon-192.png", 192, False), ("icon-512.png", 512, False),
                         ("icon-maskable-512.png", 512, True), ("apple-touch-icon.png", 180, True)]:
    img = draw(size, mask)
    if name == "apple-touch-icon.png":
        img = img.convert("RGB")
    img.save(OUT / name)
print("icons written to", OUT)
