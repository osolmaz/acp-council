"""Draw assets/cover.svg, the README cover, with every letter as an outline.

    uv run --with fonttools --with uharfbuzz --with pillow python scripts/make_cover.py YODEL_DIR MONO_DIR

YODEL_DIR holds YodelGrotesk-Bold.otf and YodelGrotesk-Regular.otf from
https://github.com/osolmaz/yodel-grotesk (assets/fonts/yodel-grotesk). MONO_DIR holds DejaVuSansMono.ttf and
DejaVuSansMono-Bold.ttf. Each string is shaped with HarfBuzz, so kerning and ligatures survive, and each glyph is
drawn at the position HarfBuzz returns. The SVG has no text elements and needs no font.

The picture: a terminal in a small project, with a real `acp-jury run` and its real output. Three agents vote on
three items about the project's code, and the jury reports how many items they agreed on.
"""

from __future__ import annotations

import hashlib
import itertools
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

WIDTH, HEIGHT = 960, 320
BACKGROUND = "#F5F0E6"
TEXT = "#111111"
SECONDARY = "#4A4A4A"
CARD = "#FFFFFF"
CARD_BORDER = "#D9D3C7"
LABEL = "#6E6A62"
BAR = "#EBE7DE"

NAME = "acp-jury"
TAGLINE = ["A command-line tool that has coding", "agents vote on questions about a folder."]

# The real session: `acp-jury run` in a small project, with its real output (stderr, then stdout).
PROMPT = "$ "
COMMAND = " run review --dir src --question question.md --items items.json"
OUTPUT = [
    "round 1: open items mean, empty, fix",
    "round 1: member:C (deepseek-v4.1-flash) voted",
    "round 1: member:A (claude-opus-5-5) voted",
    "round 1: member:B (gpt-6-astra) voted",
    "run 20261016T044944Z-41fabb: 3 agreed, 0 split after 1 round(s) (all_agreed)",
    "report: .acp-jury/runs/20261016T044944Z-41fabb/report.md",
]


@dataclass
class Font:
    face: TTFont
    hb_font: hb.Font
    upem: int

    @classmethod
    def load(cls, path: Path) -> Font:
        data = path.read_bytes()
        face = hb.Face(data)
        return cls(TTFont(path), hb.Font(face), face.upem)


def shaped(font: Font, text: str, size: float, tracking: float = 0.0) -> list[tuple[str, float]]:
    """Glyph names and x positions in pixels, with HarfBuzz's kerning, then tracking and collision fixes."""
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font.hb_font, buf, {"kern": True, "liga": True})
    names = font.face.getGlyphOrder()
    scale = size / font.upem
    out, x = [], 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions, strict=True):
        out.append((names[info.codepoint], x + pos.x_offset * scale))
        x += pos.x_advance * scale + tracking
    return separate(font, out, size)


def advance(font: Font, text: str, size: float) -> float:
    """The shaped advance width of a string, which is where the next string on the same line starts."""
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font.hb_font, buf, {"kern": True, "liga": True})
    return sum(pos.x_advance for pos in buf.glyph_positions) * size / font.upem


RASTER = 8  # outline samples per pixel when measuring the gap between two glyphs


def bounds(font: Font, glyph: str, size: float) -> tuple[float, float] | None:
    pen = BoundsPen(font.face.getGlyphSet())
    font.face.getGlyphSet()[glyph].draw(pen)
    if pen.bounds is None:
        return None
    scale = size / font.upem
    return pen.bounds[0] * scale, pen.bounds[2] * scale


def row_extents(font: Font, glyph: str, size: float) -> dict[int, tuple[float, float]]:
    """For each sampled row of the glyph's filled outline, its leftmost and rightmost x in pixels."""
    glyph_set = font.face.getGlyphSet()
    scale = size / font.upem * RASTER
    pen = RecordingPen()
    glyph_set[glyph].draw(TransformPen(pen, (scale, 0, 0, -scale, 0, 0)))
    contours = polygons(pen.value)
    if not contours:
        return {}
    xs = [x for c in contours for x, _ in c]
    ys = [y for c in contours for _, y in c]
    left, top = math.floor(min(xs)), math.floor(min(ys))
    img = Image.new("1", (math.ceil(max(xs)) - left + 2, math.ceil(max(ys)) - top + 2), 0)
    draw = ImageDraw.Draw(img)
    for contour in contours:
        draw.polygon([(x - left, y - top) for x, y in contour], fill=1)
    out: dict[int, tuple[float, float]] = {}
    for row in range(img.height):
        filled = [x for x in range(img.width) if img.getpixel((x, row))]
        if filled:
            out[row + top] = ((filled[0] + left) / RASTER, (filled[-1] + 1 + left) / RASTER)
    return out


def polygons(segments: list[tuple[str, tuple[tuple[float, float], ...]]]) -> list[list[tuple[float, float]]]:
    """A recorded outline as polygons, with each curve sampled at 8 points."""
    contours: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    for op, pts in segments:
        if op == "moveTo":
            cur = [pts[0]]
        elif op == "lineTo":
            cur.append(pts[0])
        elif op in ("qCurveTo", "curveTo"):
            cur.extend(bezier([cur[-1], *pts], step / 8) for step in range(1, 9))
        elif op in ("closePath", "endPath"):
            contours.append(cur)
            cur = []
    return [c for c in contours if len(c) > 2]


def bezier(points: list[tuple[float, float]], t: float) -> tuple[float, float]:
    while len(points) > 1:
        points = [((1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1]) for a, b in itertools.pairwise(points)]
    return points[0]


def separate(font: Font, glyphs: list[tuple[str, float]], size: float) -> list[tuple[str, float]]:
    """Push a glyph and everything after it right until its outline clears its neighbour's by 1% of the size."""
    out = list(glyphs)
    for i in range(1, len(out)):
        prev, cur = row_extents(font, out[i - 1][0], size), row_extents(font, out[i][0], size)
        shared = prev.keys() & cur.keys()
        if not shared:
            continue
        gap = min((out[i][1] + cur[r][0]) - (out[i - 1][1] + prev[r][1]) for r in shared)
        if gap < 0.01 * size:
            shift = 0.01 * size - gap
            out[i:] = [(g, x + shift) for g, x in out[i:]]
    return out


def width(font: Font, glyphs: list[tuple[str, float]], size: float) -> float:
    last, x = glyphs[-1]
    end = bounds(font, last, size)
    return x + (end[1] if end else 0)


def path(font: Font, text: str, x: float, y: float, size: float, fill: str, tracking: float = 0.0) -> str:
    """One <path> for a string with its baseline at (x, y)."""
    glyph_set = font.face.getGlyphSet()
    scale = size / font.upem
    pen = SVGPathPen(glyph_set, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
    for glyph, gx in shaped(font, text, size, tracking):
        glyph_set[glyph].draw(TransformPen(pen, (scale, 0, 0, -scale, x + gx, y)))
    return f'<path fill="{fill}" d="{pen.getCommands()}"/>'


def text_width(font: Font, text: str, size: float) -> float:
    return width(font, shaped(font, text, size), size)


BUTTONS_END = 12 + 2 * 13 + 3.2  # right edge of the third window button, measured from the window's left


def window(label_font: Font, x: float, y: float, w: float, h: float, title: str, inner: str) -> str:
    """A light macOS window: white body, gray title bar, buttons and a centered title, inner clipped to the body."""
    bar, r = 24.0, 8.0
    tw = text_width(label_font, title, 10)
    assert x + w / 2 - tw / 2 >= x + BUTTONS_END + 8, f"window title runs into the buttons: {title}"
    body = f"M{x} {y + bar}H{x + w}V{y + h - r}a{r} {r} 0 0 1 -{r} {r}H{x + r}a{r} {r} 0 0 1 -{r} -{r}Z"
    parts = [
        f'<clipPath id="body"><path d="{body}"/></clipPath>',
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{CARD}"/>',
        f'<rect x="{x}" y="{y}" width="{w}" height="{bar}" rx="{r}" fill="{BAR}"/>',
        f'<rect x="{x}" y="{y + bar - r}" width="{w}" height="{r}" fill="{BAR}"/>',
    ]
    for i, color in enumerate(("#FF5F57", "#FEBC2E", "#28C840")):
        parts.append(f'<circle cx="{x + 12 + i * 13:.1f}" cy="{y + bar / 2:.1f}" r="3.2" fill="{color}"/>')
    parts.append(path(label_font, title, x + w / 2 - tw / 2, y + bar / 2 + 3.5, 10, LABEL))
    parts.append(f'<g clip-path="url(#body)">{inner}</g>')
    parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="none" stroke="{CARD_BORDER}"/>')
    return "".join(parts)


MONO_SIZE = 9.2
LINE = 20.0
PAD = 14.0


def terminal(mono: Font, mono_bold: Font, x: float, y: float, w: float) -> str:
    """The session: the prompt, the product name in bold dark type, the rest of the command, then the output."""
    left = x + PAD
    lines = [PROMPT + "acp-jury" + COMMAND, *OUTPUT]
    for line in lines:
        assert advance(mono, line, MONO_SIZE) <= w - 2 * PAD, f"terminal line too wide: {line}"
    first = y + PAD + MONO_SIZE
    name_x = left + advance(mono, PROMPT, MONO_SIZE)
    command_x = name_x + advance(mono_bold, "acp-jury", MONO_SIZE)
    parts = [
        path(mono, PROMPT.strip(), left, first, MONO_SIZE, LABEL),
        path(mono_bold, "acp-jury", name_x, first, MONO_SIZE, TEXT),
        path(mono, COMMAND, command_x, first, MONO_SIZE, SECONDARY),
    ]
    for i, line in enumerate(OUTPUT, start=1):
        parts.append(path(mono, line, left, first + i * LINE, MONO_SIZE, SECONDARY))
    # the shell is back at its prompt when the run ends
    last = first + (len(OUTPUT) + 1) * LINE
    cursor_x = left + advance(mono, PROMPT, MONO_SIZE)
    parts.append(path(mono, PROMPT.strip(), left, last, MONO_SIZE, LABEL))
    parts.append(f'<rect x="{cursor_x:.1f}" y="{last - MONO_SIZE:.1f}" width="5.5" height="{MONO_SIZE + 2:.1f}" fill="{LABEL}"/>')
    return "".join(parts)


def build(yodel_dir: Path, mono_dir: Path) -> str:
    bold = Font.load(yodel_dir / "YodelGrotesk-Bold.otf")
    regular = Font.load(yodel_dir / "YodelGrotesk-Regular.otf")
    mono = Font.load(mono_dir / "DejaVuSansMono.ttf")
    mono_bold = Font.load(mono_dir / "DejaVuSansMono-Bold.ttf")

    text_right = max(
        64 + width(bold, shaped(bold, NAME, 64, tracking=-5), 64),
        *(64 + text_width(regular, line, 19) for line in TAGLINE),
    )
    longest = max(advance(mono, line, MONO_SIZE) for line in (PROMPT + "acp-jury" + COMMAND, *OUTPUT))
    term_w = math.ceil(longest + 2 * PAD)  # equal padding left and right of the longest line
    term_x = WIDTH - 64 - term_w - 0.5  # the window's border is centered on its edge; keep all of it inside
    assert text_right <= term_x - 32, f"text block runs into the window: {text_right:.1f} > {term_x - 32:.1f}"

    body_h = 2 * PAD + MONO_SIZE + LINE * (len(OUTPUT) + 1)
    term_h = 24 + body_h
    term_y = round((HEIGHT - term_h) / 2, 1)
    assert term_y >= 52, f"window too tall for the margins: top {term_y}"

    # the text block, centered on the window's middle
    middle = term_y + term_h / 2
    name_y = middle - 14
    label = " ".join(TAGLINE)
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{HEIGHT}" viewBox="0 0 {WIDTH} {HEIGHT}" '
        f'role="img" aria-label="acp-jury: {label}">',
        f"<title>acp-jury: {label}</title>",
        f'<rect width="{WIDTH}" height="{HEIGHT}" rx="12" fill="{BACKGROUND}"/>',
        path(bold, NAME, 64, name_y, 64, TEXT, tracking=-5),
        path(regular, TAGLINE[0], 64, name_y + 42, 19, SECONDARY),
        path(regular, TAGLINE[1], 64, name_y + 68, 19, SECONDARY),
        window(regular, term_x, term_y, term_w, term_h, "demo", terminal(mono, mono_bold, term_x, term_y + 24, term_w)),
        "</svg>",
    ]
    return "".join(parts) + "\n"


def main() -> int:
    yodel_dir, mono_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out = Path(__file__).resolve().parent.parent / "assets" / "cover.svg"
    out.parent.mkdir(exist_ok=True)
    svg = build(yodel_dir, mono_dir)
    assert "<text" not in svg and "font-family" not in svg, "delivered cover must ship no font references"
    out.write_text(svg, encoding="utf-8")
    print(out)
    for path_ in (
        yodel_dir / "YodelGrotesk-Bold.otf",
        yodel_dir / "YodelGrotesk-Regular.otf",
        mono_dir / "DejaVuSansMono.ttf",
        mono_dir / "DejaVuSansMono-Bold.ttf",
    ):
        data = path_.read_bytes()
        fs_type = TTFont(path_)["OS/2"].fsType
        print(f"{path_.name} sha256={hashlib.sha256(data).hexdigest()} fsType={fs_type}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
