#!/usr/bin/env node
/**
 * 启动页适配器（预渲染视频版）：new-splash/splash-webm.webm  ->  desktop/splash.html + desktop/splash-baked.webm
 *
 * 为什么改用预渲染视频
 * --------------------
 * 启动页原本是「实时跑 18 层大半径模糊 + JS 驱动流体与锁体进场动画」。
 * 那套画面在启动瞬间要抢 CPU：窗口首帧、渲染进程接管、后端启动全挤在一起，
 * 结果是进场动画出帧滞后、观感发卡（用户实测反馈「logo 和文字弹出有点卡」）。
 *
 * 预渲染把这部分开销整体前移到构建期：构建时把动画录成 VP9/WebM，启动时只解码播放 ——
 * 解码走 GPU，几乎不占 CPU，动画必然流畅，且画面与设计稿逐帧一致。
 *
 * 为什么是 WebM 而不是 GIF / 动画 WebP（实测依据）：
 *   - GIF：仅 256 色，这套多层半透明柔和渐变会出现明显同心色带；且体积是 WebP 的 34 倍
 *   - 动画 WebP：解码支持没问题，但浏览器内部自动播放，**拿不到「播完了」的事件**，
 *     而启动页必须靠这个信号通知主进程切主窗口（见下）
 *   - WebM(VP9)：<video> 提供 ended 事件与 currentTime，时序可精确控制；体积也更小
 *
 * 与主进程的时序契约（desktop/main.cjs 依赖，勿改）
 * ------------------------------------------------
 *   1. 页面**不用 autoplay**：等主进程在启动页窗口真正 show() 之后发 `splash:start`
 *      放行才开始播放 —— 否则视频在页面加载即起跑，而窗口 ~500ms 后才显示，
 *      用户会错过开头（logo 弹出一半）。show 之前的首帧可见性由 preload="auto"
 *      预载 + 页面底色（与视频首帧同色）兜底。
 *   2. 视频播放结束（ended）或播放失败时，调用 window.splashBridge.entranceDone()
 *      通知主进程「动画已完成」，主进程据此才切主窗口
 *   3. 若桥不存在（浏览器直接打开预览），退化为立即播放，页面照常可看
 *
 * 尺寸适配
 * --------
 * 视频按自身比例（1401×900）以 cover 铺满整个窗口：
 *   · 窗口比例与视频一致（默认 1400×900 ≈ 1.5567）时 **1:1 原样呈现**，与设计稿逐像素一致；
 *   · 其它比例只等比放大并裁掉边缘抽象渐变，logo 组位于画面中部永不被裁。
 * 注意**不要把舞台写死成 16:9**：视频本身不是 16:9，写死会在非 16:9 窗口上把视频
 * 放大后再四边裁切（实测 1400×1016 窗口下放大 1.29 倍、左右各裁 14%，构图明显失真）。
 *
 * 用法：node scripts/build-splash.mjs
 *   自动从 new-splash/ 寻找 .webm 源（优先 splash-webm.webm），
 *   复制到 desktop/splash-baked.webm 并生成 desktop/splash.html。
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DST_HTML = path.join(ROOT, 'desktop', 'splash.html')
const DST_VIDEO = path.join(ROOT, 'desktop', 'splash-baked.webm')

/** WebM 源候选（按优先级；用户可能放在不同目录名） */
const VIDEO_CANDIDATES = [
  path.join(ROOT, 'new-splash', 'splash-webm.webm'),
  path.join(ROOT, 'new-splash', 'new-splash', 'splash.webm'),
  path.join(ROOT, 'new-splash', 'hyperplayer-splash', 'splash.webm'),
]

const srcVideo = VIDEO_CANDIDATES.find((p) => existsSync(p))
if (!srcVideo) {
  throw new Error(
    '未找到 WebM 启动页素材。请把录制好的 .webm 放到以下任一位置：\n  ' +
    VIDEO_CANDIDATES.map((p) => path.relative(ROOT, p)).join('\n  '),
  )
}

const videoBytes = statSync(srcVideo).size
if (videoBytes < 1024) throw new Error(`WebM 素材过小（${videoBytes} 字节），疑似损坏：${srcVideo}`)

copyFileSync(srcVideo, DST_VIDEO)

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!-- 启动页是 file:// 加载的离线页面：CSP 禁止一切外部资源（视频为本地同目录文件） -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; script-src 'unsafe-inline'">
<title>HyperPlayer</title>
<!--
  本文件由 scripts/build-splash.mjs 生成，请勿手改。

  预渲染启动页：整段动画（流体背景 + logo/文字进场）已在构建期录成 VP9/WebM，
  启动时只解码播放 —— 解码走 GPU，不占 CPU，因此不会与主窗口的加载抢资源，
  动画必然流畅，且画面与设计稿逐帧一致。

  时序契约（desktop/main.cjs 依赖）：
    ① 主进程在启动页窗口真正 show() 后发 splash:start 放行，页面收到才开始播放（不用 autoplay）；
    ② 视频播完（或播放失败）→ 调 window.splashBridge.entranceDone() → 主进程才切主窗口。
  这样动画起点与用户所见严格对齐、且「动画完整播完」才切走，
  也避免切换时主窗口尚未绘制造成的黑屏一闪。

  尺寸：视频按自身比例（1401×900）cover 铺满窗口 —— 窗口比例与视频一致时
  1:1 原样呈现；不同比例只裁掉边缘抽象渐变，logo 组位于画面中部，永不被裁。
-->
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    width: 100%; height: 100%; margin: 0; padding: 0;
    overflow: hidden;
    /* 兜底色：与视频首帧的渐变起点一致，杜绝视频解码出来之前闪白/闪黑 */
    background: #EEF2FF;
    user-select: none; -webkit-user-select: none;
    cursor: default;
  }
  /* 舞台外框：铺满窗口并裁掉溢出 */
  .stage-wrap { position: fixed; inset: 0; overflow: hidden; }
  /* 舞台 = 窗口本身；视频按自身比例 cover（勿写死 16:9，见文件头「尺寸适配」） */
  .stage {
    position: absolute; inset: 0;
    overflow: hidden;
  }
  .stage video {
    display: block;
    width: 100%; height: 100%;
    /* 保持视频自身比例铺满窗口，避免黑边；超出的只是边缘抽象渐变 */
    object-fit: cover;
    /* 关掉视频自身的交互痕迹（启动页不需要控件） */
    pointer-events: none;
  }
</style>
</head>
<body>
<div class="stage-wrap">
  <div class="stage">
    <!-- 不用 autoplay：等主进程通知窗口已真正显示（splash:start）再播放。
         否则视频会在页面加载时就开始跑，而窗口要 ~500ms 后才 show ——
         用户看到时动画已经播掉一截（logo 已弹出部分），观感就成了「半路开始」。 -->
    <video id="splash-video" src="./splash-baked.webm"
           muted playsinline preload="auto" disablepictureinpicture></video>
  </div>
</div>
<script>
  /* 与主进程的两条时序契约：
       · splash:start（主进程 → 页面）：窗口已真正显示，现在可以开始播放动画；
       · entranceDone（页面 → 主进程）：动画播完了，可以切主窗口。
     这样动画起点与用户所见严格对齐，也不会「播到一半被切走」。
     无桥时（浏览器直接打开预览）退化为立即播放，页面照常可看。 */
  (function () {
    var reported = false;
    function reportDone(reason) {
      if (reported) return;
      reported = true;
      var bridge = (typeof window !== 'undefined' && window.splashBridge) || null;
      if (bridge && typeof bridge.entranceDone === 'function') {
        try { bridge.entranceDone(); } catch (e) { /* 回报失败不影响页面 */ }
      }
      if (reason) {
        try { console.log('[splash] entranceDone: ' + reason); } catch (e) {}
      }
    }

    var v = document.getElementById('splash-video');
    if (!v) { reportDone('no-video-element'); return; }

    var bridge = (typeof window !== 'undefined' && window.splashBridge) || null;
    var started = false;

    // 播完 / 出错都要回报，避免主进程干等到兜底超时
    v.addEventListener('ended', function () { reportDone('ended'); });
    v.addEventListener('error', function () { reportDone('error'); });

    function play() {
      if (started) return;
      started = true;
      var p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function () {
          // 自动播放被拒（muted 理论上不会），稍后重试一次；仍失败则按错误处理
          setTimeout(function () {
            var p2 = v.play();
            if (p2 && typeof p2.catch === 'function') p2.catch(function () { reportDone('play-rejected'); });
          }, 120);
        });
      }
      // 兜底：若 ended 事件因故未触发，按视频时长 + 余量后强制回报
      var ms = (isFinite(v.duration) && v.duration > 0 ? v.duration * 1000 : 5000) + 700;
      setTimeout(function () { reportDone('timeout-guard'); }, ms);
    }

    // 等主进程放行；无桥时立即播放（浏览器预览场景）
    if (bridge && typeof bridge.onStart === 'function') {
      bridge.onStart(play);
    } else {
      play();
    }
  })();
</script>
</body>
</html>
`

writeFileSync(DST_HTML, html, 'utf8')

console.log(`已生成 ${path.relative(ROOT, DST_HTML)}`)
console.log(`  视频源  : ${path.relative(ROOT, srcVideo)}`)
console.log(`  已复制到: ${path.relative(ROOT, DST_VIDEO)}  (${(videoBytes / 1024 / 1024).toFixed(2)} MB)`)
console.log('  尺寸: 视频原比例(1401×900) cover 铺满窗口；时序: splash:start 放行播放，播完经 splashBridge.entranceDone() 回报')
const leftover = html.match(/https?:\/\//g)
console.log(`  外部链接: ${leftover ? leftover.join(', ') + '（需检查）' : '无（完全离线）'}`)
