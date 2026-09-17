"""Verity logotype: the V mark as the 'V', 'erity' set in Rubik and outlined.

Regenerates verity-logo.svg / verity-logo-inverted.svg. The wordmark ships as
outlines so the files carry no font dependency; Rubik is OFL, see
docs/licenses/rubik.txt.

    pip install fonttools uharfbuzz
    curl -o rubik-400.ttf https://fonts.gstatic.com/s/rubik/v31/iJWZBXyIfDnIV5PNhY1KTN7Z-Yh-B4i1UA.ttf
    python build-logo.py
"""
import math
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.misc.transform import Transform

CAP, ASC, DESC = 700.0, 726.0, -190.0       # Rubik cap height, i-dot, y descender
APEX = (128.0, 220.0); TL = (40.0, 36.0); TR = (216.0, 36.0); HW = 16.0
GREEN_FROM, GREEN_TO, LEG = 54.0, 162.0, 88.0   # the mark's dash window, per leg

u = ((APEX[0] - TL[0]), (APEX[1] - TL[1]))
L = math.hypot(*u); u = (u[0] / L, u[1] / L)
n = (u[1], -u[0])                                # outward normal, left leg
MITER = HW / math.sin(math.atan2(APEX[0] - TL[0], APEX[1] - TL[1]))

def pt(base, k):                                 # a point k/LEG along a leg
    return (TL[0] + u[0] * L * k, TL[1] + u[1] * L * k) if base == "l" else \
           (APEX[0] + (TR[0] - APEX[0]) * k, APEX[1] + (TR[1] - APEX[1]) * k)

def off(p, nv, s): return (p[0] + nv[0] * s, p[1] + nv[1] * s)

TIP = (APEX[0], APEX[1] + MITER)
INNER = (APEX[0], APEX[1] - MITER)
A_out, A_in = off(TL, n, -HW), off(TL, n, HW)
C_out, C_in = (2 * APEX[0] - A_out[0], A_out[1]), (2 * APEX[0] - A_in[0], A_in[1])
P1 = pt("l", GREEN_FROM / LEG); P1_out, P1_in = off(P1, n, -HW), off(P1, n, HW)
P2 = pt("r", (GREEN_TO - LEG) / LEG)
P2_out, P2_in = (2 * APEX[0] - P1_in[0], 0), (2 * APEX[0] - P1_out[0], 0)
n2 = (-n[0], n[1])
P2_out, P2_in = off(P2, n2, -HW), off(P2, n2, HW)

RED = [A_out, TIP, C_out, C_in, INNER, A_in]
GRN = [P1_out, TIP, P2_out, P2_in, INNER, P1_in]
M = {"left": A_out[0], "right": C_out[0], "mid_top": TL[1], "tip": TIP[1]}

def build(weight=400, overshoot=8.0, tighten=0.0, tracking=0.0, word="#202c29", out="logo.svg"):
    path = f"rubik-{weight}.ttf"
    tt = TTFont(path); gs = tt.getGlyphSet(); order = tt.getGlyphOrder()
    s = (CAP + overshoot) / (M["tip"] - M["mid_top"])
    mark_w = (M["right"] - M["left"]) * s

    vg = tt.getBestCmap()[ord("V")]; vgl = tt["glyf"][vg]
    v_adv, v_lsb = tt["hmtx"][vg]; v_w = vgl.xMax - vgl.xMin
    r = mark_w / v_w
    lsb, rsb = v_lsb * r, (v_adv - v_lsb - v_w) * r
    x = round(lsb + mark_w + rsb - tighten)

    blob = hb.Blob.from_file_path(path); f = hb.Font(hb.Face(blob))
    buf = hb.Buffer(); buf.add_str("Verity"); buf.guess_segment_properties()
    hb.shape(f, buf, {"kern": True, "liga": True})
    rec = RecordingPen()
    for info, pos in list(zip(buf.glyph_infos, buf.glyph_positions))[1:]:
        gs[order[info.codepoint]].draw(TransformPen(rec, Transform().translate(x + pos.x_offset, 0)))
        x += pos.x_advance + tracking
    right = x - tracking

    sp = SVGPathPen(gs, ntos=lambda v: f"{v:g}")
    rec.replay(TransformPen(sp, Transform(1, 0, 0, -1, 0, CAP)))
    word_d = sp.getCommands()

    def T(p): return (round(lsb + (p[0] - M["left"]) * s, 2), round((p[1] - M["mid_top"]) * s, 2))
    def poly(ps): return "M" + " ".join(f"{a:g} {b:g}" for a, b in map(T, ps)) + "Z"

    y0, y1 = CAP - ASC, CAP - DESC
    vb = f"0 {y0:g} {right:g} {y1 - y0:g}"
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" '
           f'aria-labelledby="verity-logo-title">\n'
           f'  <title id="verity-logo-title">Verity</title>\n'
           f'  <path d="{poly(RED)}" fill="#D3444C" />\n'
           f'  <path d="{poly(GRN)}" fill="#149766" />\n'
           f'  <path d="{word_d}" fill="{word}" />\n</svg>\n')
    open(out, "w").write(svg)
    print(out, "| mark", round(mark_w), "vs V", v_w, "| stroke", round(32 * s), "| w", round(right))

if __name__ == "__main__":
    build(tighten=70, out="verity-logo.svg")
    build(tighten=70, word="#ffffff", out="verity-logo-inverted.svg")
