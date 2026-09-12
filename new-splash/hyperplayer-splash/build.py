#!/usr/bin/env python3
"""
HyperPlayer — living splash screen builder.

Takes the plain pen.dev HTML export (../splash.html), then produces a single
self-contained `index.html`:

  * the logo is inlined as a data URI   -> no missing images
  * the Space Grotesk font is inlined   -> no internet needed
  * the fluid background is animated in JS (requestAnimationFrame) instead of
    CSS keyframes, so nothing (reduced-motion settings, media queries,
    animation shut-off flags) can silently freeze it

Only `transform` + `opacity` are written each frame, on layers promoted with
`will-change`, so the browser composites instead of repainting the blurs.

Re-export from pen.dev, then run:  python build.py
"""

import base64
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "splash.html")
LOGO = os.path.join(HERE, "assets", "logo-mark.png")
FONT = os.path.join(HERE, "assets", "space-grotesk-700.woff2")
DST = os.path.join(HERE, "index.html")

# ---------------------------------------------------------------------------
# motion table: ax/ay = travel (px), sc = scale breath, rot = rotation drift,
# t1/t2 = the two sine periods (s), op = opacity breath.
# every layer starts from rest (= exactly the pen.dev design) and drifts out.
# SPEED >1 makes the whole field flow faster.
# ---------------------------------------------------------------------------
SPEED = 1.6
RESPECT_REDUCED_MOTION = False

LAYERS = {
    "Color Wash":     (70, -50, 0.08, 0, 31, 19, 0.00),
    "Pool Indigo":    (120, -70, 0.12, 0, 25, 17, 0.08),
    "Mass Blue":      (140, 90, 0.14, 2, 21, 29, 0.00),
    "Smoke Azure":    (230, -70, 0.10, 5, 18, 23, 0.10),
    "Haze Violet":    (-130, 95, 0.12, -2, 23, 31, 0.00),
    "Bloom Magenta":  (-160, -90, 0.14, 3, 20, 27, 0.08),
    "Heat Coral":     (-140, 80, 0.12, 2, 22, 33, 0.00),
    "Amber Sun":      (-110, 110, 0.10, 0, 19, 25, 0.10),
    "Ribbon Mint":    (280, -90, 0.08, 10, 17, 37, 0.12),
    "Ribbon Aqua":    (-260, 80, 0.08, -10, 21, 41, 0.12),
    "Vein Light":     (230, 100, 0.06, 3, 16, 43, 0.14),
    "Glass Streak":   (110, -50, 0.05, 2, 26, 35, 0.00),
    # colour-morph pairs: each pair shares one drift, their opacities swing in
    # antiphase (see MORPH) so the hue of that region visibly re-tints.
    "Morph Center A": (140, -90, 0.12, 3, 24, 19, 0.00),
    "Morph Center B": (140, -90, 0.12, 3, 24, 19, 0.00),
    "Morph Right A":  (-150, 110, 0.12, -3, 22, 26, 0.00),
    "Morph Right B":  (-150, 110, 0.12, -3, 22, 26, 0.00),
    "Morph Left A":   (130, 100, 0.12, 3, 21, 29, 0.00),
    "Morph Left B":   (130, 100, 0.12, 3, 21, 29, 0.00),
}

# name -> (sign, amplitude, period_s); partners use opposite signs.
# amplitude 1.0 = opacity swings from 0 to 2x its design value.
MORPH = {
    "Morph Center A": (1, 1.0, 16),
    "Morph Center B": (-1, 1.0, 16),
    "Morph Right A":  (1, 1.0, 20),
    "Morph Right B":  (-1, 1.0, 20),
    "Morph Left A":   (-1, 1.0, 14),
    "Morph Left B":   (1, 1.0, 14),
}

SCRIPT = """    <script>
      /* HyperPlayer — living fluid background + lockup entrance.
         Every value below is safe to tweak; the design itself lives in pen.dev. */
      (function () {
        var SPEED = __SPEED__;
        var RESPECT_REDUCED_MOTION = __RRM__;
        if (RESPECT_REDUCED_MOTION &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

        var TAU = Math.PI * 2;
        var LAYERS = __LAYERS__;
        var MORPH = __MORPH__;

        /* entrance: both halves of the lockup start hidden behind the seam
           (the dashed line that sits between logo and wordmark) and spring
           outward. dx > 0 = starts right of its resting place (logo, travels
           left), dx < 0 = starts left of it (wordmark, travels right). */
        var ENTRANCE = [
          { name: 'Logo Tile', dx: 150, sc: 0.86, blur: 16, dur: 1800, delay: 80 },
          { name: 'Wordmark', dx: -250, sc: 0.96, blur: 14, dur: 1750, delay: 200 }
        ];
        var easeOutCubic = function (x) { return 1 - Math.pow(1 - x, 3); };
        /* gentle spring: ~6% overshoot past the resting place, then settle */
        var easeOutBack = function (x, c1) {
          var c3 = c1 + 1;
          return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
        };

        var items = [];
        var nodes = document.querySelectorAll('[data-pencil-name]');
        for (var i = 0; i < nodes.length; i++) {
          var el = nodes[i];
          var cfg = LAYERS[el.getAttribute('data-pencil-name')];
          if (!cfg) continue;
          var inline = el.style.transform || '';
          var m = /rotate\\(\\s*(-?[\\d.]+)deg/.exec(inline);
          var baseRot = m ? parseFloat(m[1]) : 0;
          var baseOp = el.style.opacity !== '' ? parseFloat(el.style.opacity) : 1;
          if (!el.style.transformOrigin) el.style.transformOrigin = 'top left';
          el.style.willChange = 'transform, opacity';
          items.push({ el: el, c: cfg, rot: baseRot, op: baseOp, m: MORPH[el.getAttribute('data-pencil-name')] });
        }
        if (!items.length) return;

        var ent = [];
        for (var e = 0; e < ENTRANCE.length; e++) {
          var node = document.querySelector(
            '[data-pencil-name="' + ENTRANCE[e].name + '"]');
          if (!node) continue;
          node.style.willChange = 'transform, opacity, filter';
          ent.push({ el: node, c: ENTRANCE[e], done: false });
        }

        var t0 = null;
        function frame(now) {
          if (t0 === null) t0 = now;
          /* tReal = real seconds (drives the one-shot lockup entrance, so its
             ~2s length is independent of the SPEED knob);
             t = the fluid clock, scaled by SPEED */
          var tReal = (now - t0) / 1000;
          var t = tReal * SPEED;

          /* --- lockup entrance (runs once, then leaves the design untouched) --- */
          for (var k = 0; k < ent.length; k++) {
            var it2 = ent[k];
            if (it2.done) continue;
            var c2 = it2.c;
            var ms = tReal * 1000 - c2.delay;
            var p = ms <= 0 ? 0 : (ms >= c2.dur ? 1 : ms / c2.dur);
            var mv = p >= 1 ? 1 : easeOutBack(p, 1.2);    /* position: springs */
            var op = easeOutCubic(Math.min(1, p * 1.25));  /* visibility settles early */
            var inv = 1 - mv;
            it2.el.style.transform =
              'translate3d(' + (c2.dx * inv).toFixed(2) + 'px,0,0) ' +
              'scale(' + (1 + (c2.sc - 1) * inv).toFixed(4) + ')';
            it2.el.style.opacity = op.toFixed(3);
            it2.el.style.filter = c2.blur
              ? 'blur(' + (c2.blur * inv).toFixed(2) + 'px)' : '';
            if (p >= 1) {
              it2.el.style.transform = '';
              it2.el.style.opacity = '';
              it2.el.style.filter = '';
              it2.done = true;
            }
          }

          for (var i = 0; i < items.length; i++) {
            var it = items[i], c = it.c;
            var p1 = (t * TAU) / c.v[4];
            var p2 = (t * TAU) / c.v[5];
            /* every term is zero at t = 0, so frame 1 is pixel-for-pixel the
               design from pen.dev and the fluid grows out of it */
            var dx = c.v[0] * Math.sin(p1) + c.v[0] * 0.35 * Math.sin(p2 * 1.23);
            var dy = c.v[1] * 0.60 * Math.sin(p1 * 0.83) + c.v[1] * 0.35 * Math.sin(p2 * 0.77);
            var sc = 1 + c.v[2] * (0.5 - 0.5 * Math.cos(p2 * 0.91));
            var rt = c.v[3] * Math.sin(p1 * 0.70);
            it.el.style.transform =
              'translate3d(' + dx.toFixed(2) + 'px,' + dy.toFixed(2) + 'px,0) ' +
              'rotate(' + (it.rot + rt).toFixed(3) + 'deg) scale(' + sc.toFixed(4) + ')';
            if (it.m) {
              /* colour morph: partner layers swing in opposite directions, so the
                 hue of that region continuously re-tints instead of just sliding */
              var f = 1 + it.m[0] * it.m[1] * Math.sin((t * TAU) / it.m[2]);
              it.el.style.opacity = Math.max(0, Math.min(1, it.op * f)).toFixed(3);
            } else if (c.v[6]) {
              it.el.style.opacity =
                (it.op * (1 - c.v[6] * (0.5 - 0.5 * Math.cos(p2 * 1.07)))).toFixed(3);
            }
          }
          window.requestAnimationFrame(frame);
        }
        function tick() {
          frame(window.performance ? performance.now() : Date.now());
        }
        /* paint frame 1 synchronously, then run the smooth rAF loop.
           the interval is a safety net: browsers throttle rAF to zero for
           occluded/minimised views, the timer keeps everything moving. */
        tick();
        window.requestAnimationFrame(frame);
        window.setInterval(tick, 100);

        /* press R to replay the entrance (and restart the fluid from rest) */
        window.addEventListener('keydown', function (ev) {
          if (ev.key === 'r' || ev.key === 'R') {
            t0 = null;
            for (var r = 0; r < ent.length; r++) ent[r].done = false;
            tick();
          }
        });
      })();
    </script>
"""


def data_uri(path, mime):
    with open(path, "rb") as fh:
        return "data:%s;base64,%s" % (mime, base64.b64encode(fh.read()).decode("ascii"))


def main():
    with open(SRC, encoding="utf-8") as fh:
        html = fh.read()

    # 1. logo -> data URI
    logo = data_uri(LOGO, "image/png")
    html = re.sub(r"url\(['\"]?\.?/?logo-mark\.png['\"]?\)", "url(%s)" % logo, html)

    # 2. font -> inline @font-face (drop the Google Fonts requests)
    font = data_uri(FONT, "font/woff2")
    html = re.sub(r'\s*<link[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>', "", html)
    face = (
        "    <style>\n"
        "      @font-face {\n"
        "        font-family: 'Space Grotesk';\n"
        "        font-style: normal;\n"
        "        font-weight: 700;\n"
        "        font-display: block;\n"
        "        src: url(%s) format('woff2');\n"
        "      }\n"
        "    </style>\n  " % font
    )
    html = html.replace("</head>", face + "</head>", 1)

    # 3. drop any previously injected animation style block
    html = re.sub(r'\n\s*<style id="hp-fluid-flow">.*?</style>', "", html, flags=re.S)

    # 4. inject the JS animator
    layers_js = "{\n"
    for name, v in LAYERS.items():
        layers_js += '          "%s": { v: [%s] },\n' % (
            name,
            ", ".join("%g" % x for x in v),
        )
    layers_js += "        }"
    morph_js = "{\n"
    for name, m in MORPH.items():
        morph_js += '          "%s": [%s],\n' % (name, ", ".join("%g" % x for x in m))
    morph_js += "        }"
    script = (
        SCRIPT.replace("__SPEED__", "%g" % SPEED)
        .replace("__RRM__", "true" if RESPECT_REDUCED_MOTION else "false")
        .replace("__LAYERS__", layers_js)
        .replace("__MORPH__", morph_js)
    )
    html = html.replace("</body>", script + "  </body>", 1)

    with open(DST, "w", encoding="utf-8") as fh:
        fh.write(html)

    left = re.findall(r"https?://[^\"')\s]+", html)
    print("wrote %s (%.1f KB)" % (DST, os.path.getsize(DST) / 1024.0))
    print("layers animated: %d" % len(LAYERS))
    print("external references left:", left if left else "none — fully offline")


if __name__ == "__main__":
    main()
