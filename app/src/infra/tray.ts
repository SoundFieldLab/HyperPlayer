/**
 * infra tray/window —— 托盘与窗口控制薄封装（后端补充规划 #42，UI-D77）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { TrayIcon } from '@tauri-apps/api/tray';
import type { TrayIconOptions } from '@tauri-apps/api/tray';
import { Image } from '@tauri-apps/api/image';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import type { MenuItemOptions } from '@tauri-apps/api/menu/menuItem';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** 托盘菜单项（id 由服务层定义并映射动作）。 */
export interface TrayMenuItem {
  id: string;
  label: string;
}

export interface Tray {
  /** 构建托盘图标 + 菜单；iconUrl 为前端内嵌资源（随 dist 打包，dev/prod 均可 fetch）。 */
  build(iconUrl: string, items: Array<TrayMenuItem | 'separator'>, onItem: (id: string) => void): Promise<void>;
  destroy(): Promise<void>;
}

/** 主窗口控制（托盘显示/隐藏/退出 + 关闭拦截）。 */
export interface WindowControl {
  show(): Promise<void>;
  hide(): Promise<void>;
  setFocus(): Promise<void>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
  /** 直接关闭（不触发 closeRequested）。 */
  destroy(): Promise<void>;
  /** 关闭请求拦截：回调内调用 event.preventDefault() 可阻止关闭。 */
  onCloseRequested(handler: (event: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
}

export function createTauriTray(): Tray {
  let tray: TrayIcon | null = null;
  return {
    build: async (iconUrl, items, onItem) => {
      const menuItems = [];
      for (const item of items) {
        if (item === 'separator') {
          menuItems.push(await PredefinedMenuItem.new({ item: 'Separator' }));
          continue;
        }
        const options: MenuItemOptions = { id: item.id, text: item.label, action: () => onItem(item.id) };
        menuItems.push(await MenuItem.new(options));
      }
      const menu = await Menu.new({ items: menuItems });
      // 图标以内嵌前端资源字节传入（image-png feature）：不依赖 exe 旁的文件路径，
      // 便携版/NSIS/dev 三种形态一致。
      const response = await fetch(iconUrl);
      if (!response.ok) throw new Error(`tray: 图标资源加载失败 ${response.status} ${iconUrl}`);
      const icon = await Image.fromBytes(new Uint8Array(await response.arrayBuffer()));
      const options: TrayIconOptions = { icon, menu };
      tray = await TrayIcon.new(options);
    },
    destroy: async () => {
      if (tray) {
        await tray.close();
        tray = null;
      }
    },
  };
}

export function createTauriWindowControl(): WindowControl {
  const window = getCurrentWindow();
  return {
    show: () => window.show(),
    hide: () => window.hide(),
    setFocus: () => window.setFocus(),
    minimize: () => window.minimize(),
    toggleMaximize: async () => {
      if (await window.isMaximized()) await window.unmaximize();
      else await window.maximize();
    },
    close: () => window.close(),
    startDragging: () => window.startDragging(),
    destroy: () => window.destroy(),
    onCloseRequested: (handler) => window.onCloseRequested((event) => handler(event)),
  };
}
