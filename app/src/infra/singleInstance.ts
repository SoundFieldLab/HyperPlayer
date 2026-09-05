/**
 * infra singleInstance —— 二次启动事件薄封装（后端补充规划 #40）。
 * Rust 侧 single-instance 插件在二次启动时 emit 'single-instance' 事件，
 * JS 侧监听并聚焦主窗口；载荷（args/cwd）透传给业务钩子（文件打开 #41 留待后续）。
 */
import { listen } from '@tauri-apps/api/event';
import type { WindowControl } from './tray';

export interface SecondInstancePayload {
  args: string[];
  cwd: string;
}

export interface SingleInstance {
  /** 二次启动：聚焦主窗口并回调载荷。返回解绑函数。 */
  onSecondInstance(cb: (payload: SecondInstancePayload) => void): Promise<() => void>;
}

export function createTauriSingleInstance(control: WindowControl): SingleInstance {
  return {
    onSecondInstance: async (cb) =>
      listen<{ args?: string[]; cwd?: string }>('single-instance', (event) => {
        void control.setFocus();
        cb({ args: event.payload?.args ?? [], cwd: event.payload?.cwd ?? '' });
      }),
  };
}
