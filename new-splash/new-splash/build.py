#!/usr/bin/env python3
"""
HyperPlayer — living splash screen builder（1400×900 版）

Takes the plain pen.dev HTML export (./splash.html, 画布 1400×900),
then produces a single self-contained `index.html`:

  * the logo is inlined as a data URI   -> no missing images
  * the Space Grotesk font is inlined   -> no internet needed
  * the fluid background + lockup entrance are animated in JS
    (requestAnimationFrame) instead of CSS keyframes, so nothing
    (reduced-motion settings, media queries, animation shut-off flags)
    can silently freeze it

Only `transform` + `opacity` (+ the entrance's filter) are written each frame,
on layers promoted with `will-change`, so the browser composites instead of
repainting the blurs.

与 1920×1080 版（../hyperplayer-splash/build.py）的唯一实质差别：
**运动幅度按画布宽度等比缩放**。LAYERS 表里的 ax/ay 与 ENTRANCE 的 dx/blur
原值是 1920 基准的像素；本画布 1400 宽，故数值统一乘以 1400/1920 = 0.7292，
使运动的视觉幅度与原设计一致（否则在这个画布上位移会偏大 37%）。

用法：python build.py
"""

import base64
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "splash.html")
LOGO = os.path.join(HERE, "logo-mark.png")
FONT = os.path.join(HERE, "assets", "space-grotesk-700.woff2")
DST = os.path.join(HERE, "index.html")

# 画布宽度（pen.dev 导出的画布尺寸）。LAYERS/ENTRANCE 的位移量按此归一化。
CANVAS_WIDTH = 1400
# LAYERS / ENTRANCE 原值对应的画布宽度（1920×1080 版的设计基准）
BASE_WIDTH = 1920
SCALE = CANVAS_WIDTH / BASE_WIDTH  # 0.7292

# ---------------------------------------------------------------------------
# motion table: ax/ay = travel (px, BASE_WIDTH 基准), sc = scale breath,
# rot = rotation drift, t1/t2 = the two sine periods (s), op = opacity breath.
# every layer starts from rest (= exactly the pen.dev design) and drifts out.
# SPEED >1 makes the whole field flow faster.
# ---------------------------------------------------------------------------
SPEED = 1.6
RESPECT_REDUCED_MOTION = False

# 原始表（1920×1080 基准）。下方统一乘 SCALE 得到本画布用的值。
LAYERS_1920 = {
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

# 位移量（v[0], v[1]）按 SCALE 缩放；缩放呼吸/旋转/周期/透明度是无量纲或秒，保持不变。
LAYERS = {
    name: (v[0] * SCALE, v[1] * SCALE, v[2], v[3], v[4], v[5], v[6])
    for name, v in LAYERS_1920.items()
}

# 锁体进场：dx（位移）与 blur（起始模糊）是 BASE_WIDTH 基准像素，同样按 SCALE 缩放；
# dur/delay 是真实毫秒，与画布尺寸无关。
ENTRANCE = [
    {"name": "Logo Tile", "dx": 150 * SCALE, "sc": 0.86, "blur": 16 * SCALE, "dur": 1800, "delay": 80},
    {"name": "Wordmark", "dx": -250 * SCALE, "sc": 0.96, "blur": 14 * SCALE, "dur": 1750, "delay": 200},
]

ENTRANCE_JS = ",\n          ".join(
    "{ name: '%s', dx: %g, sc: %g, blur: %g, dur: %d, delay: %d }"
    % (e["name"], e["dx"], e["sc"], e["blur"], e["dur"], e["delay"])
    for e in ENTRANCE
)

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
          __ENTRANCE__
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

        /* ── 时序回报：进场动画播完后通知宿主（Electron 启动页用）──
           宿主靠这个信号才知道动画播完了、可以切主窗口。
           无桥时（浏览器直接打开）自动跳过，页面照常播放。 */
        var __entranceDone = false;
        var __bridge = (typeof window !== 'undefined' && window.splashBridge) || null;
        function __notifyEntranceDone() {
          if (__entranceDone) return;
          __entranceDone = true;
          if (__bridge && typeof __bridge.entranceDone === 'function') {
            try { __bridge.entranceDone(); } catch (err) { /* 回报失败不影响页面 */ }
          }
        }
        function __checkEntranceDone() {
          if (__entranceDone) return;
          for (var kk = 0; kk < ent.length; kk++) {
            if (!ent[kk].done) return;
          }
          __notifyEntranceDone();
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
          /* 全部播完 → 通知宿主 */
          __checkEntranceDone();

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
        /* 没有任何进场元素时立即回报，避免宿主干等 */
        if (!ent.length) __notifyEntranceDone();

        /* press R to replay the entrance (and restart the fluid from rest) */
        window.addEventListener('keydown', function (ev) {
          if (ev.key === 'r' || ev.key === 'R') {
            t0 = null;
            __entranceDone = false;
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

    # 1. logo -> data URI（兼容 ./logo-mark.png / logo-mark.png / url('...') 等写法）
    logo = data_uri(LOGO, "image/png")
    html = re.sub(r"url\(['\"]?\.?/?logo-mark\.png['\"]?\)", "url(%s)" % logo, html)
    # 也处理 <img src="logo-mark.png"> 的写法
    html = re.sub(r'(<img[^>]*\ssrc=)["\']\.?/?logo-mark\.png["\']', r'\1"%s"' % logo, html)

    # 2. font -> inline @font-face（去掉 Google Fonts 请求，打包版必须离线可用）
    font = data_uri(FONT, "font/woff2")
    html = re.sub(r'\s*<link[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>', "", html)
    html = re.sub(r'\s*<link[^>]*preconnect[^>]*>', "", html)
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
        .replace("__ENTRANCE__", ENTRANCE_JS)
        .replace("__MORPH__", morph_js)
    )
    html = html.replace("</body>", script + "  </body>", 1)

    with open(DST, "w", encoding="utf-8") as fh:
        fh.write(html)

    left = re.findall(r"https?://[^\"')\s]+", html)
    print("wrote %s (%.1f KB)" % (DST, os.path.getsize(DST) / 1024.0))
    print("canvas: %dpx  运动幅度按 %d 基准缩放 ×%.4f" % (CANVAS_WIDTH, BASE_WIDTH, SCALE))
    print("layers animated: %d" % len(LAYERS))
    print("entrance: %s" % ", ".join(e["name"] for e in ENTRANCE))
    print("external references left:", left if left else "none — fully offline")


if __name__ == "__main__":
    main()
