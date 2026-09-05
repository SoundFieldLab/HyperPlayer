/**
 * infra tray/window —— 托盘与窗口控制薄封装（后端补充规划 #42，UI-D77）。
 * 所有原生能力经本层；单测用 fakes/ 替换，不碰 Tauri。
 */
import { TrayIcon } from '@tauri-apps/api/tray';
import type { TrayIconOptions } from '@tauri-apps/api/tray';
import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import type { MenuItemOptions } from '@tauri-apps/api/menu/menuItem';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** 托盘菜单项（id 由服务层定义并映射动作）。 */
export interface TrayMenuItem {
  id: string;
  label: string;
}

export interface Tray {
  /** 构建托盘图标 + 菜单；菜单项点击按 id 回调。 */
  build(iconPath: string, items: Array<TrayMenuItem | 'separator'>, onItem: (id: string) => void): Promise<void>;
  destroy(): Promise<void>;
}

/** 主窗口控制（托盘显示/隐藏/退出 + 关闭拦截）。 */
export interface WindowControl {
  show(): Promise<void>;
  hide(): Promise<void>;
  setFocus(): Promise<void>;
  /** 直接关闭（不触发 closeRequested）。 */
  destroy(): Promise<void>;
  /** 关闭请求拦截：回调内调用 event.preventDefault() 可阻止关闭。 */
  onCloseRequested(handler: (event: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
}

export function createTauriTray(): Tray {
  let tray: TrayIcon | null = null;
  return {
    build: async (iconPath, items, onItem) => {
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
      const options: TrayIconOptions = { icon: iconPath, menu };
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
    destroy: () => window.destroy(),
    onCloseRequested: (handler) => window.onCloseRequested((event) => handler(event)),
  };
}
