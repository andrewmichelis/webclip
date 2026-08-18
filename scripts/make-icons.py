#!/usr/bin/env python3
"""Generate WebClip toolbar icons: a white saved-page (document with a folded corner) on the
KnackMentor brand gradient running DIAGONALLY (blue top-left -> green bottom-right), in a rounded
square. Pure standard library (no Pillow). Final bespoke artwork can replace these by overwriting
src/assets/icons/. Usage: python3 scripts/make-icons.py   (then `npm run build` copies to dist/icons/)
"""
import os
import struct
import zlib

KM_BLUE = (53, 96, 176)    # #3560b0
KM_GREEN = (31, 155, 110)  # #1f9b6e
WHITE = (255, 255, 255)
LINE = (206, 210, 220)     # faint "text" lines on the page
SIZES = (16, 32, 48, 128)
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "icons")


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def in_rounded_square(x: int, y: int, n: int) -> bool:
    r = max(3, n // 5)
    for cx, cy in ((r, r), (n - 1 - r, r), (r, n - 1 - r), (n - 1 - r, n - 1 - r)):
        if (x < r or x > n - 1 - r) and (y < r or y > n - 1 - r):
            if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
                return False
    return True


def gradient(x: int, y: int, n: int):
    """Diagonal brand gradient: blue at the top-left corner, green at the bottom-right."""
    t = (x + y) / (2 * (n - 1)) if n > 1 else 0
    return lerp(KM_BLUE, KM_GREEN, t)


def page_pixel(x: int, y: int, n: int):
    """White document with a top-right dog-ear and three faint text lines. Returns a colour to paint,
    or None to let the gradient show (outside the page, and inside the cut-away corner)."""
    x0, x1 = round(n * 0.30), n - 1 - round(n * 0.30)
    y0, y1 = round(n * 0.19), n - 1 - round(n * 0.19)
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return None
    fold = round((x1 - x0) * 0.40)
    if (x1 - x) + (y - y0) < fold:          # cut the top-right corner -> folded page
        return None
    for i, ly in enumerate((0.36, 0.52, 0.68)):
        yy = round(y0 + (y1 - y0) * ly)
        line_right = x1 - round(n * 0.06) - (fold if i == 0 else 0)
        if yy <= y < yy + max(2, round(n * 0.045)) and x0 + round(n * 0.06) <= x <= line_right:
            return LINE
    return WHITE


def icon_rgba(n: int) -> bytes:
    rows = bytearray()
    for y in range(n):
        rows.append(0)  # PNG filter type 0
        for x in range(n):
            if not in_rounded_square(x, y, n):
                rows.extend((0, 0, 0, 0))           # transparent outside the tile
                continue
            col = page_pixel(x, y, n)
            rows.extend((*(col if col else gradient(x, y, n)), 255))
    return bytes(rows)


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: str, n: int) -> None:
    ihdr = struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(icon_rgba(n), 9)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for n in SIZES:
        write_png(os.path.join(OUT, f"icon-{n}.png"), n)
        print(f"icon-{n}.png")


if __name__ == "__main__":
    main()
