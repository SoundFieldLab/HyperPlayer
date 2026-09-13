/**
 * 启动页（splash）专用 preload —— 只做三件事：与主进程对齐时序 + 诊断打点。
 *
 * 为什么需要它：
 *   1. **开始时机**：启动页窗口从「页面加载」到「程序就绪」之间有一段等待
 *      （主窗口首帧 + 主窗口加载完成 + 本地后端就绪）。这段时间页面只显示视频
 *      第 0 帧（纯背景，无 logo/文字）当占位 —— 天然不卡、也不占解码资源；
 *      等主进程在程序就绪后发 `splash:start` 放行，才真正播入场动画，
 *      动画就不会和启动抢资源。
 *   2. **结束时机**：动画播完后要通知主进程切主窗口，否则会出现「动画播到一半
 *      被切走」或「主窗口迟迟不出现」。页面播完调 `entranceDone()`。
 *   3. **诊断**：`mark()` 把页面侧的时间点与帧节拍统计转给主进程写进启动日志。
 *
 * 只暴露这三个方法，不触碰 Node/文件系统（启动页是离线只读页面）。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('splashBridge', {
  /** 订阅「程序已就绪，可以开始播放入场动画」信号；返回取消订阅函数 */
  onStart: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = () => { try { callback() } catch { /* 忽略页面异常，不影响启动 */ } }
    ipcRenderer.on('splash:start', listener)
    return () => ipcRenderer.removeListener('splash:start', listener)
  },
  /** 动画播完（或播放失败），通知主进程可以切主窗口了 */
  entranceDone: () => ipcRenderer.send('splash:entrance-done'),
  /**
   * 诊断打点：页面侧把关键时间点/帧节拍统计写进启动日志
   * （主进程侧 splash:mark 监听已存在，只在带 HYPERPLAYER_STARTUP_LOG 时落盘）
   */
  mark: (name, sincePageLoadMs) => ipcRenderer.send('splash:mark', name, sincePageLoadMs),
})
