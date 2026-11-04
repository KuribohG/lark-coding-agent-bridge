#!/usr/bin/env python3
"""Generate installer/tray/app.ico without any third-party dependency.

A blue round badge with a white chat bubble.  Every size is rendered with 4x
supersampling and stored as a PNG-compressed ICO entry (supported by Windows
Vista and later), which keeps the file small and the edges clean.
"""

import os
import struct
import zlib

SIZES = [16, 24, 32, 48, 64, 128, 256]
SUPERSAMPLE = 4

BLUE = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)


def render(size: int) -> bytes:
    """Return RGBA bytes for one square icon, drawn at `size` pixels."""
    n = size * SUPERSAMPLE
    c = n / 2.0
    radius = n * 0.47
    r2 = radius * radius

    # Chat bubble geometry in normalized coordinates.
    bx0, by0, bx1, by1 = n * 0.245, n * 0.30, n * 0.755, n * 0.595
    corner = n * 0.075
    tx0, ty0, tx1, ty1 = n * 0.33, n * 0.58, n * 0.30, n * 0.73

    # Precompute coverage accumulators (premultiplied) for the downsample.
    acc = [[[0, 0.0, 0.0, 0.0] for _ in range(size)] for _ in range(size)]

    for y in range(n):
        fy = y + 0.5
        for x in range(n):
            fx = x + 0.5
            dx, dy = fx - c, fy - c
            color = None
            if dx * dx + dy * dy <= r2:
                color = BLUE
            if _inside_round_rect(fx, fy, bx0, by0, bx1, by1, corner):
                color = WHITE
            if _inside_triangle(fx, fy, tx0, ty0, tx1, ty1, (n * 0.42, n * 0.58)):
                color = WHITE
            if color is not None:
                cell = acc[y // SUPERSAMPLE][x // SUPERSAMPLE]
                a = color[3] / 255.0
                cell[0] += a
                cell[1] += color[0] * a
                cell[2] += color[1] * a
                cell[3] += color[2] * a

    samples = float(SUPERSAMPLE * SUPERSAMPLE)
    out = bytearray()
    for row in acc:
        for total_a, r, g, b in row:
            if total_a <= 0.0:
                out += b"\x00\x00\x00\x00"
                continue
            alpha = total_a / samples
            out += bytes((
                int(round(r / total_a)),
                int(round(g / total_a)),
                int(round(b / total_a)),
                int(round(alpha * 255)),
            ))
    return bytes(out)


def _inside_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    # Inside the straight edges; corner circles are centered on (cx, cy).
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def _inside_triangle(px, py, x0, y0, x1, y1, apex):
    x2, y2 = apex
    d1 = (px - x1) * (y0 - y1) - (x0 - x1) * (py - y1)
    d2 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)
    d3 = (px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def png(rgba: bytes, size: int) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter type: none
        raw += rgba[y * stride:(y + 1) * stride]
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def main() -> None:
    root = os.path.dirname(os.path.abspath(__file__))
    target = os.path.join(root, "app.ico")
    images = [(s, png(render(s), s)) for s in SIZES]

    header = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries = b""
    data = b""
    for size, blob in images:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        data += blob
    with open(target, "wb") as fh:
        fh.write(header + entries + data)
    print("wrote %s (%d bytes, sizes %s)" % (target, os.path.getsize(target), SIZES))


if __name__ == "__main__":
    main()
