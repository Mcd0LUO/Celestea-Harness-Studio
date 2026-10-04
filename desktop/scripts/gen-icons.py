#!/usr/bin/env python3
"""Generate the Celestea Studio app icon and tray glyph.

The mark is drawn geometrically (no font, no external asset): a near-black
rounded tile carrying a bold white ring with a gap on the right and a square dot
sitting in that gap. It reads as "C" (Celestea) with an agent/node dot at 512 px,
and it still resolves at 16 px because there are exactly two shapes and both are
thick.

Everything is drawn on masks at 8x the target size and downscaled with LANCZOS,
which is what keeps the ring edges clean at tray sizes without any vector
rasterizer on the host. Outputs (all committed, all regenerable with
`python3 desktop/scripts/gen-icons.py`):

  icon-16/32/64/128/256/512.png   the tile icon, per platform icon set
  icon.ico                        multi-size Windows icon (16..256, PNG-packed)
  tray.png                        tray glyph for LIGHT backgrounds (dark ink)
  tray-dark.png                   tray glyph for DARK backgrounds (white ink)
  icon.svg                        the same geometry as an editable vector

The tray pair follows the `Deno.Tray` convention: `setIcon` is the base icon
(light menu bars / light panels) and `setIconDark` is the dark-mode variant.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ICONS_DIR = Path(__file__).resolve().parent.parent / "icons"

# --- geometry, all in fractions of the icon side ---------------------------
#
# Two lessons are baked into these numbers, both from looking at rendered
# previews rather than at the maths:
#   - the dot must stay INSIDE the ring's outer circle. When it poked past it,
#     the silhouette was a circle with a bump and the mark read as right-heavy.
#   - below 48 px the dot has ~2 px of ink, which turns into grey mush. Small
#     sizes therefore draw the C alone, with a wider opening so the gap survives
#     downscaling (the same simplification system icons use).
SUPERSAMPLE = 8
TILE_SIZE = 512
CORNER_RATIO = 0.18  # squarer tile: 0.22 went almost circular at 16 px
RING_OUTER_RATIO = 0.330
RING_INNER_RATIO = 0.205
GAP_HALF_DEGREES = 52.0  # the ring's opening, centred on the +x axis
GAP_HALF_DEGREES_SMALL = 56.0  # dot-free small sizes: only a touch wider
RING_INNER_RATIO_SMALL = 0.180  # dot-free small sizes carry a thicker stroke
DOT_RATIO = 0.155  # square dot side
DOT_DISTANCE_RATIO = 0.235  # dot centre: inside the ring, clear of both gap edges
DOT_MIN_SIZE = 48  # below this the mark is drawn without the dot

# --- palette ---------------------------------------------------------------
TILE_COLOR = (11, 11, 12, 255)
MARK_COLOR = (255, 255, 255, 255)
TRAY_INK_LIGHT_BG = (17, 17, 19, 255)
TRAY_INK_DARK_BG = (255, 255, 255, 255)

TRAY_SIZE = 22  # logical px; the docs' recommendation for status areas
ICO_SIZES = [16, 32, 48, 64, 128, 256]


def has_dot(size: int) -> bool:
    """Whether this size gets the dot: it needs enough pixels to exist."""
    return size >= DOT_MIN_SIZE


def glyph_mask(size: int) -> Image.Image:
    """The mark as an 8-bit mask (255 = ink), drawn at `size` px."""
    work = size * SUPERSAMPLE
    mask = Image.new("L", (work, work), 0)
    draw = ImageDraw.Draw(mask)
    center = work / 2
    outer = work * RING_OUTER_RATIO
    # Small, dot-free sizes get a thicker stroke: at 16 px a 0.125 * 16 = 2 px
    # ring reads as a broken arc, while 0.150 * 16 = 2.4 px survives.
    inner = work * (RING_INNER_RATIO if has_dot(size) else RING_INNER_RATIO_SMALL)
    gap = GAP_HALF_DEGREES if has_dot(size) else GAP_HALF_DEGREES_SMALL

    box_outer = [center - outer, center - outer, center + outer, center + outer]
    box_inner = [center - inner, center - inner, center + inner, center + inner]
    draw.ellipse(box_outer, fill=255)
    draw.ellipse(box_inner, fill=0)
    # Cut the opening: a wedge from -gap to +gap (PIL angles are clockwise from +x).
    draw.pieslice(box_outer, -gap, gap, fill=0)

    if has_dot(size):
        # The dot sits in the opening, inside the ring's outer circle so the
        # mark's silhouette stays round.
        dot = work * DOT_RATIO
        cx = center + work * DOT_DISTANCE_RATIO
        draw.rounded_rectangle(
            [cx - dot / 2, center - dot / 2, cx + dot / 2, center + dot / 2], radius=dot * 0.22, fill=255
        )

    return mask.resize((size, size), Image.LANCZOS)


def tile_icon(size: int) -> Image.Image:
    """The full app icon: rounded tile + white mark."""
    work = size * SUPERSAMPLE
    tile = Image.new("RGBA", (work, work), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle(
        [0, 0, work - 1, work - 1], radius=work * CORNER_RATIO, fill=TILE_COLOR
    )
    tile = tile.resize((size, size), Image.LANCZOS)

    mark = Image.new("RGBA", (size, size), MARK_COLOR)
    mark.putalpha(glyph_mask(size))
    return Image.alpha_composite(tile, mark)


def tray_glyph(size: int, ink: tuple[int, int, int, int]) -> Image.Image:
    """The mark alone, transparent background, for status areas."""
    glyph = Image.new("RGBA", (size, size), ink)
    glyph.putalpha(glyph_mask(size))
    return glyph


def icon_svg() -> str:
    """The same geometry as vector, for future edits (not used at build time)."""
    s = TILE_SIZE
    c = s / 2
    outer = s * RING_OUTER_RATIO
    inner = s * RING_INNER_RATIO
    dot = s * DOT_RATIO
    dx = c + s * DOT_DISTANCE_RATIO
    gap = GAP_HALF_DEGREES
    # Start/end of the arc: the gap is centred on +x, so the arc runs from +gap
    # around to 360-gap (SVG arcs are counter-clockwise from +x, y down).
    start = math.radians(gap)
    end = math.radians(360 - gap)
    x1, y1 = c + outer * math.cos(start), c + outer * math.sin(start)
    x2, y2 = c + outer * math.cos(end), c + outer * math.sin(end)
    x3, y3 = c + inner * math.cos(end), c + inner * math.sin(end)
    x4, y4 = c + inner * math.cos(start), c + inner * math.sin(start)
    large = 1
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s} {s}" width="{s}" height="{s}">
  <rect width="{s}" height="{s}" rx="{s * CORNER_RATIO:.1f}" fill="#0b0b0c"/>
  <path fill="#ffffff" fill-rule="evenodd"
        d="M {x1:.2f} {y1:.2f}
           A {outer:.2f} {outer:.2f} 0 {large} 1 {x2:.2f} {y2:.2f}
           L {x3:.2f} {y3:.2f}
           A {inner:.2f} {inner:.2f} 0 {large} 0 {x4:.2f} {y4:.2f} Z"/>
  <rect x="{dx - dot / 2:.2f}" y="{c - dot / 2:.2f}" width="{dot:.2f}" height="{dot:.2f}" rx="{dot * 0.22:.2f}" fill="#ffffff"/>
</svg>
"""


def main() -> int:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    for size in (16, 32, 64, 128, 256, 512):
        path = ICONS_DIR / f"icon-{size}.png"
        tile_icon(size).save(path)
        written.append(path.name)

    base = tile_icon(256)
    base.save(ICONS_DIR / "icon.ico", sizes=[(n, n) for n in ICO_SIZES])
    written.append("icon.ico")

    tray_glyph(TRAY_SIZE, TRAY_INK_LIGHT_BG).save(ICONS_DIR / "tray.png")
    tray_glyph(TRAY_SIZE, TRAY_INK_DARK_BG).save(ICONS_DIR / "tray-dark.png")
    written += ["tray.png", "tray-dark.png"]

    (ICONS_DIR / "icon.svg").write_text(icon_svg(), encoding="utf-8")
    written.append("icon.svg")

    print(f"[desktop] wrote {len(written)} icons into {ICONS_DIR}: {', '.join(written)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
