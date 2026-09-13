/**
 * 启动页（splash）专用 preload —— 只做两件事：与主进程对齐时序。
 *
 * 为什么需要它：
 *   1. **开始时机**：启动页窗口从「页面加载」到「真正显示给用户」之间约有
 *      500ms 落差（建窗、渲染进程初始化、show 调度）。若视频/动画在页面加载时
 *      就起跑，用户看到时已经播掉一截（logo 弹出一半），观感成了「半路开始」。
 *      故由主进程在 show() 之后发 `splash:start` 放行，页面收到才开始播放。
 *   2. **结束时机**：动画播完后要通知主进程切主窗口，否则会出现「动画播到一半
 *      被切走」或「主窗口迟迟不出现」。页面播完调 `entranceDone()`。
 *
 * 只暴露这两个方法，不触碰 Node/文件系统（启动页是离线只读页面）。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('splashBridge', {
  /** 订阅「窗口已显示，可以开始播放动画」信号；返回取消订阅函数 */
  onStart: (callback) => {
    if (typeof callback !== 'function') return () => {}
    const listener = () => { try { callback() } catch { /* 忽略页面异常，不影响启动 */ } }
    ipcRenderer.on('splash:start', listener)
    return () => ipcRenderer.removeListener('splash:start', listener)
  },
  /** 动画播完（或播放失败），通知主进程可以切主窗口了 */
  entranceDone: () => ipcRenderer.send('splash:entrance-done'),
})
