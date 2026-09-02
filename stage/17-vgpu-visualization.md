# Stage 17：vGPU 可视化

状态：待选择

## 当前基础与目标

当前没有 vGPU/WebGPU 生产接入；已有 HPTM v2、Canvas2D 波形/频谱外壳和 UI-D80 边界。本切片将 vGPU 0.3.1 作为可选渲染层，用于封面氛围、按需频谱/波形、DSP 曲线/仪表和空间场，并保留完整 fallback。

非目标：让 GPU 计算权威 DSP/FFT/LUFS/HRTF、向前端传原始 PCM、在迷你播放器或桌面歌词创建独立 GPU context。

## 前置门禁

依赖 Stage 07/09 的稳定 telemetry；单个可重建 context；运行时检测 WebGPU；窗口隐藏、减少动效和 device loss 时降级且不影响播放。

## 预计修改与任务

增加已审计 vGPU 依赖；实现 renderer/context lifecycle、Canvas2D/SVG/DOM fallback；接主窗口页面、主题和测试。

1. 建立 capability probe、单 context 和资源释放协议。
2. 先实现一个最小频谱/曲线 renderer，并与 Canvas 输出对照。
3. 接 B 材质封面氛围、meter 和空间场，保持 A 方案克制。
4. 处理 resize、DPI、隐藏、恢复、device loss 和减少动效。
5. 限制 GPU/CPU 占用并记录 telemetry 丢帧，不回压播放。

## 测试与验收

正式 Tauri/WebView2 下做 desktop/mobile-like 最小窗口多尺寸截图、canvas pixel 非空、动态更新、fallback 强制路径、device-loss 恢复和长时资源测试。最后由视觉 judge/用户逐页确认。

不得提供浏览器产品预览或 mock bridge；fallback 可用前不能宣称完成。

## 完成后同步

更新 UI-D80 实施状态、handover、验收矩阵和实测性能记录。
