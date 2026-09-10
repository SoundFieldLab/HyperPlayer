/**
 * TV 遥控器交互核心 —— 桌面空壳（HyperPlayer 减配版）。
 *
 * 原实现（空间导航 / 焦点环 / 聚焦域 / BACK 栈 / 软键盘 / 全局键监听）已随
 * TV 专属模块一并移除。本文件保留全部原有具名导出，签名保持不变，
 * 函数体统一为空实现，使其余组件继续 `import { ... } from './tv/tvCore'`
 * 无需任何改动即可通过编译。所有状态类钩子恒返回“未启用”值。
 */

/** BACK 处理器签名（与原实现一致；原为文件内私有类型，未对外导出）。 */
type BackHandler = () => boolean

/** 当前是否 TV 遥控器模式。桌面空壳恒为 false。 */
export function isTvMode(): boolean {
  return false
}

/** React Hook：当前是否 TV 遥控器模式。 */
export function useTvMode(): boolean {
  return false
}

/** 手机遥控器是否处于连接（光标模式）。桌面空壳恒为 false。 */
export function isRemoteCursorMode(): boolean {
  return false
}

/** 设置手机遥控器光标模式（空壳：无副作用）。 */
export function setRemoteCursorMode(v: boolean): void {
  void v
}

/** React Hook：手机遥控器是否处于连接（光标模式）。 */
export function useRemoteCursorMode(): boolean {
  return false
}

/** 当前焦点元素。桌面空壳恒为 null。 */
export function getFocusedElement(): HTMLElement | null {
  return null
}

/** React Hook：当前焦点元素。桌面空壳恒为 null。 */
export function useTvFocus(): HTMLElement | null {
  return null
}

/** 软键盘是否处于激活态。桌面空壳恒为 false。 */
export function isKeyboardActive(): boolean {
  return false
}

/** 设置软键盘激活态（空壳：无副作用）。 */
export function setKeyboardActive(v: boolean): void {
  void v
}

/** 设置当前焦点元素（空壳：无副作用）。 */
export function setTvFocus(el: HTMLElement | null): void {
  void el
}

/** 注册 BACK 处理器（空壳：不注册任何处理器）。 */
export function useTvBack(handler: BackHandler, deps: ReadonlyArray<unknown> = []): void {
  void handler
  void deps
}

/** 触发一次 BACK。空壳恒返回 false（未被消费）。 */
export function dispatchTvBack(): boolean {
  return false
}

/** 初始化 TV 交互（空壳：无副作用）。 */
export function initTv(): void {}

/** 文档就绪后启动 TV（空壳：无副作用）。 */
export function startTv(): void {}

/** 是否已激活 TV。桌面空壳恒为 false。 */
export function isTvActive(): boolean {
  return false
}
