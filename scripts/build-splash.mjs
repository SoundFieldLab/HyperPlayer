#!/usr/bin/env node
/**
 * 启动页适配器：new-splash/hyperplayer-splash/index.html  ->  desktop/splash.html
 *
 * 为什么需要这一步
 * ----------------
 * 设计稿（pen.dev 导出 + hyperplayer-splash/build.py 加工）是一张 **固定 1920×1080** 的画布：
 * 所有图层都是绝对定位的 px 值。直接当 Electron 启动页用会有两个问题：
 *
 *   1. **尺寸不匹配**：启动页窗口跟随主窗口（默认 1400×900，用户还可能改过并记在
 *      window-state.json），1920×1080 的画布会溢出被裁掉一大块，并出现滚动条。
 *   2. **性能**：即便用 transform:scale 把画布缩到窗口大小，元素的**布局尺寸仍是
 *      1920×1080**，浏览器依然要按这个大尺寸去栅格化那 18 层大半径模糊 ——
 *      实测原样 28.9fps、transform:scale 36.1fps，都不理想。
 *
 * 做法
 * ----
 * 把「布局尺寸」真正缩小到窗口尺寸，并按比例缩放全部几何量，使两者等价：
 *   - 舞台（stage）恒为 **16:9**，按 **cover** 铺满窗口：
 *       width : max(100vw, 100vh * 16/9)
 *       height: max(100vh, 100vw * 9/16)
 *     这样任意窗口比例下都等比放大、不拉伸、不留黑边，只裁掉边缘的抽象渐变；
 *     而 logo 组位于舞台正中，永远不会被裁到。
 *   - 舞台设 `container-type: inline-size`，于是 **1cqw = 舞台宽/100**。
 *     设计稿基准宽 1920px ⇒ 1px = 100/1920 = 0.0520833cqw。
 *     所有 px 几何量（left/top/width/height/border-radius/border/font-size/
 *     letter-spacing/box-shadow/blur）一律按此换算为 cqw —— 单位统一，天然等比。
 *   - JS 里的运动幅度（LAYERS 的 ax/ay、ENTRANCE 的 dx/blur）以 px 记，运行时
 *     乘以 S = 舞台宽/1920 换算，与 CSS 侧保持一致。
 *
 * 结果：**任意窗口尺寸下构图与 1920×1080 设计稿完全等比一致**，且模糊是在
 * 实际（更小的）分辨率上计算的，省掉大量栅格化开销。
 *
 * 保留设计原样
 * ------------
 * 运动学（LAYERS/MORPH/ENTRANCE 数值、SPEED、时长、缓动、颜色）**原样保留**，
 * 只做单位与尺寸的等比换算；字体与 logo 仍是设计自带的 data URI（完全离线）。
 *
 * 用法：node scripts/build-splash.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'new-splash', 'hyperplayer-splash', 'index.html')
const DST = path.join(ROOT, 'desktop', 'splash.html')

/** 设计稿基准（pen.dev 画布） */
const BASE_W = 1920
const BASE_H = 1080

/** 需要等比换算的 CSS 属性（含 px 数值者） */
const SCALED_PROPS = new Set([
  'left', 'top', 'right', 'bottom',
  'width', 'height',
  'border-radius', 'border', 'border-width',
  'font-size', 'letter-spacing', 'word-spacing',
  'box-shadow', 'text-shadow',
  'filter', 'backdrop-filter',
  'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
  'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
])

const PX_RE = /(-?\d*\.?\d+)px/g
/** 1px 对应多少 cqw（舞台宽 = 100cqw = BASE_W px） */
const toCqw = (px) => {
  const v = (Number(px) * 100) / BASE_W
  // 去掉浮点噪声，保留足够精度
  return `${Number(v.toFixed(4))}cqw`
}

/** 把一个 CSS 声明值里的 px 换成 cqw（含 url(data:...) 的值整段跳过，避免误伤 base64） */
function convertValue(value) {
  if (value.includes('url(')) return value
  return value.replace(PX_RE, (_, num) => toCqw(num))
}

/** 转换一段 style 属性内容（不含外层引号） */
function convertStyle(styleText) {
  return styleText
    .split(';')
    .map((decl) => {
      const idx = decl.indexOf(':')
      if (idx < 0) return decl
      const prop = decl.slice(0, idx).trim()
      const value = decl.slice(idx + 1)
      if (!SCALED_PROPS.has(prop)) return decl
      return `${prop}:${convertValue(value)}`
    })
    .join(';')
}

/** 转换整份 HTML 中所有 style="..." / style='...' 属性 */
function convertStyleAttributes(html) {
  // 双引号：样式值里不会出现未转义的双引号；base64 仅含 [A-Za-z0-9+/=]，安全
  let out = html.replace(/(\sstyle=")([^"]*)(")/g, (_, a, body, c) => a + convertStyle(body) + c)
  // 单引号（设计稿里 Wordmark 用单引号）
  out = out.replace(/(\sstyle=')([^']*)(')/g, (_, a, body, c) => a + convertStyle(body) + c)
  return out
}

// ─────────────────────────── 读取源文件 ───────────────────────────

const source = readFileSync(SRC, 'utf8')

// 1) 取出 head 里的 <style> 块（normalize + @font-face 的 data URI 字体），原样保留
const styleBlocks = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])

// 2) 取出 <script> 块（流体动画 + 锁体进场）
const scriptMatch = source.match(/<script>([\s\S]*?)<\/script>/)
if (!scriptMatch) throw new Error('源文件缺少 <script> 块')
let script = scriptMatch[1]

// 3) 取出根画布（data-pencil-name="1. Splash · 16:9"）及其全部子层
const bodyMatch = source.match(/<body>([\s\S]*?)<\/body>/)
if (!bodyMatch) throw new Error('源文件缺少 <body>')
let bodyHtml = bodyMatch[1].replace(scriptMatch[0], '').trim()

// ─────────────────────────── 几何换算：px -> cqw ───────────────────────────

bodyHtml = convertStyleAttributes(bodyHtml)

// 根画布本身是「舞台」，不能用 cqw 描述自身尺寸（cqw 取的是祖先容器）——
// 它的尺寸必须按 cover 规则铺满窗口，且要覆盖源文件里的固定 1920×1080。
// 注意：内联样式优先级高于类规则，因此尺寸必须写在这里（而非 .stage 类里），
// 否则被内联值覆盖。这里同时承担「建立容器查询上下文」的职责。
bodyHtml = bodyHtml.replace(
  /(<div\s+data-pencil-name="1\. Splash · 16:9"[\s\S]*?style=")([\s\S]*?)(")/,
  (_, head, styleBody, tail) => {
    let fixed = styleBody
      .replace(/width:\s*[^;"]*;?/g, '')
      .replace(/height:\s*[^;"]*;?/g, '')
      .replace(/\s*;\s*;/g, ';')
      .replace(/^;|;$/, '')
    fixed = fixed.trim()
    const stageSize = [
      'position:absolute',
      'left:50%', 'top:50%',
      'transform:translate(-50%,-50%)',
      // 恒 16:9 且不小于窗口：任意窗口比例下等比放大，只裁边缘抽象渐变
      `width:max(100vw, calc(100vh * ${BASE_W} / ${BASE_H}))`,
      `height:max(100vh, calc(100vw * ${BASE_H} / ${BASE_W}))`,
      // 建立容器查询上下文：此后 1cqw = 舞台宽/100
      'container-type:inline-size',
    ].join(';')
    return `${head}${stageSize};${fixed}${tail}`
  },
)

// ─────────────────────────── JS：运动幅度按同一比例换算 ───────────────────────────

// 在 IIFE 开头注入舞台宽度比例 S（= 舞台宽 / 1920），与 CSS 侧 1px = 0.0520833cqw 等价
script = script.replace(
  /(\(function \(\) \{)/,
  `$1
        /* 舞台宽度比例：设计稿基准 1920px，S = 舞台宽/1920。
           与 CSS 侧「1px = 100/1920 cqw」完全等价，保证 JS 运动幅度与几何等比。 */
        var stageEl = document.querySelector('[data-pencil-name="1. Splash · 16:9"]');
        var S = stageEl ? stageEl.clientWidth / ${BASE_W} : 1;
        if (!S) S = 1;`,
)

// LAYERS 的 ax/ay（v[0]、v[1]）是 px 位移，读取时按 S 换算
script = script.replace(
  /var cfg = LAYERS\[el\.getAttribute\('data-pencil-name'\)\];\s*\n\s*if \(!cfg\) continue;/,
  `var base = LAYERS[el.getAttribute('data-pencil-name')];
          if (!base) continue;
          /* 位移幅度按舞台比例缩放（缩放/旋转/周期/透明度为无量纲或秒，无需换算） */
          var cfg = { v: [base.v[0] * S, base.v[1] * S].concat(base.v.slice(2)) };`,
)

// 锁体进场的 dx（px）与起始模糊 blur（px）同样换算
script = script.replace(
  /'translate3d\(' \+ \(c2\.dx \* inv\)\.toFixed\(2\) \+ 'px,0,0\) '/,
  `'translate3d(' + (c2.dx * S * inv).toFixed(2) + 'px,0,0) '`,
)
script = script.replace(
  /'blur\(' \+ \(c2\.blur \* inv\)\.toFixed\(2\) \+ 'px\)'/,
  `'blur(' + (c2.blur * S * inv).toFixed(2) + 'px)'`,
)

// ─────────────────────────── 性能优化：去掉全屏毛玻璃的 backdrop-filter ───────────────────────────
//
// 实测（本机 1400×900，GPU 合成 enabled，3 轮取中位数）：
//   19 层模糊全开           25.7 fps
//   仅关掉全屏毛玻璃这一层   31.0 fps   ← 单层 +21%
//   关掉全部 19 层          60.2 fps
//
// 原因：`backdrop-filter` 每帧都要**读取其背后整屏像素再模糊**，而这一层是全屏（100cqw × 56.25cqw）。
// 它背后已经是 18 层 blur(3.6~4.8cqw ≈ 60~90px) 的重度模糊光斑 —— 对已重度模糊的内容再糊 17~24px，
// 视觉上几乎无从分辨。实测去掉它前后：**平均色差 0.55/255、最大 6/255、仅 0.4% 采样点差异 >2**，
// 属肉眼不可辨范围。保留其静态白罩（#FFFFFF66）与边框，观感不变。
//
// 注意：这里**只**去掉这一层的 backdrop-filter；那些构成流体观感的光斑 blur 全部原样保留
//（曾尝试过削减光斑 blur，会导致柔和光斑退化为硬边圆角矩形，视觉不合格，故不做）。
const GLASS_SHEET = 'Glass Sheet'
const BEFORE_OPT = bodyHtml
bodyHtml = bodyHtml.replace(
  new RegExp(`(<div\\s+data-pencil-name="${GLASS_SHEET}"[\\s\\S]*?style=")([\\s\\S]*?)(")`),
  (_, head, styleBody, tail) => {
    const cleaned = styleBody
      .replace(/backdrop-filter:\s*[^;"]*;?/g, '')
      .replace(/-webkit-backdrop-filter:\s*[^;"]*;?/g, '')
      .replace(/\s*;\s*;/g, ';')
    return head + cleaned + tail
  },
)
if (bodyHtml === BEFORE_OPT) {
  console.warn('⚠️  未找到 Glass Sheet 层，跳过去毛玻璃优化（设计可能已变更）')
}

// ─────────────────────────── 组装输出 ───────────────────────────

const stageCss = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%; margin: 0; padding: 0;
    overflow: hidden;
    background: #EEF2FF;              /* 兜底色：与舞台渐变起点一致，杜绝首帧闪色 */
    user-select: none; -webkit-user-select: none;
    cursor: default;
  }
  /* 舞台外框：铺满窗口并裁掉溢出（舞台自身的尺寸/居中由内联样式定义，见下） */
  .stage-wrap {
    position: fixed; inset: 0;
    overflow: hidden;
  }
`

const out = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- 启动页是 file:// 加载的离线页面：CSP 显式禁止一切外部资源（字体与 logo 均为 data URI） -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:; script-src 'unsafe-inline'">
<title>HyperPlayer</title>
<!--
  本文件由 scripts/build-splash.mjs 从 new-splash/hyperplayer-splash/index.html 生成，请勿手改。
  设计：pen.dev 画布 -> hyperplayer-splash/build.py（内联字体/logo + JS 流体动画）-> 本适配器。

  适配器做了两件事：
    1. 几何等比化：固定 1920×1080 画布的 px 几何量统一换算为 cqw，
       舞台恒为 16:9 并按 cover 铺满窗口 —— 任意窗口尺寸/比例下构图都与设计稿一致；
       logo 组位于正中，永远完整可见。
    2. 布局尺寸跟随窗口：真正缩小了布局尺寸（而非只做 transform 缩放），
       使那 18 层大半径模糊在实际分辨率上栅格化，显著降低渲染开销。
  运动学（速度/时长/缓动/颜色/图层参数）与设计稿保持原样。
-->
<style>${stageCss}</style>
${styleBlocks.map((b) => `<style>${b}</style>`).join('\n')}
</head>
<body>
<div class="stage-wrap">
${bodyHtml.replace('data-pencil-name="1. Splash · 16:9"', 'data-pencil-name="1. Splash · 16:9" class="stage"')}
</div>
<script>${script}</script>
</body>
</html>
`

writeFileSync(DST, out, 'utf8')

// ─────────────────────────── 自检 ───────────────────────────

const leftoverPx = (out.match(/\d+px/g) || []).filter((v) => v !== '0px')
console.log(`已生成 ${path.relative(ROOT, DST)}`)
console.log(`  舞台: 16:9 cover（base ${BASE_W}x${BASE_H}）`)
console.log(`  残留非零 px 值: ${leftoverPx.length} 处${leftoverPx.length ? ' -> ' + [...new Set(leftoverPx)].slice(0, 10).join(', ') : ''}`)
console.log(`  含外部链接: ${/https?:\/\//.test(out.replace(/xmlns="[^"]*"/g, '')) ? '是（需检查）' : '否'}`)
