/**
 * TrayService —— 系统托盘业务（后端补充规划 #42，UI-D77）。
 *
 * - 托盘菜单：显示主窗口 / 播放暂停 / 上一首 / 下一首 / 完全退出（UI-D77 清单）；
 * - 关闭拦截：closeBehavior=minimize → preventDefault + hide（最小化到托盘）；
 *   closeBehavior=quit → 放行关闭；ask 由 UI 先行落定后再写入设置。
 */
import type { Tray, TrayMenuItem, WindowControl } from '../infra/tray';
import type { SettingsService } from './SettingsService';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export type TrayMenuId = 'show' | 'playPause' | 'next' | 'prev' | 'quit';

export interface TrayCommands {
  playPause: () => void | Promise<void>;
  next: () => void | Promise<void>;
  prev: () => void | Promise<void>;
}

export interface TrayServiceDeps {
  tray: Tray;
  window: WindowControl;
  settings: SettingsService;
  commands: TrayCommands;
  logger?: Logger;
}

const TRAY_ICON = 'icons/icon.png';

export class TrayService {
  private readonly deps: TrayServiceDeps;
  private readonly logger: Logger;
  private readonly unbind: Array<() => void> = [];

  constructor(deps: TrayServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
  }

  async init(): Promise<void> {
    const items: Array<TrayMenuItem | 'separator'> = [
      { id: 'show', label: '显示主窗口' },
      'separator',
      { id: 'playPause', label: '播放/暂停' },
      { id: 'next', label: '上一首' },
      { id: 'prev', label: '下一首' },
      'separator',
      { id: 'quit', label: '完全退出' },
    ];
    await this.deps.tray.build(TRAY_ICON, items, (id) => this.handleMenu(id));
    this.unbind.push(await this.deps.window.onCloseRequested((event) => this.handleClose(event)));
  }

  async dispose(): Promise<void> {
    for (const unbind of this.unbind) unbind();
    this.unbind.length = 0;
    await this.deps.tray.destroy();
  }

  private handleMenu(id: string): void {
    switch (id as TrayMenuId) {
      case 'show':
        void this.deps.window.show();
        void this.deps.window.setFocus();
        break;
      case 'playPause':
        void Promise.resolve(this.deps.commands.playPause()).catch((error) => this.logger.warn('tray: playPause 失败', error));
        break;
      case 'next':
        void Promise.resolve(this.deps.commands.next()).catch((error) => this.logger.warn('tray: next 失败', error));
        break;
      case 'prev':
        void Promise.resolve(this.deps.commands.prev()).catch((error) => this.logger.warn('tray: prev 失败', error));
        break;
      case 'quit':
        void this.deps.window.destroy();
        break;
      default:
        this.logger.warn(`tray: 未知菜单项 ${id}`);
    }
  }

  private handleClose(event: { preventDefault(): void }): void {
    if (this.deps.settings.snapshot.closeBehavior === 'minimize') {
      event.preventDefault();
      void this.deps.window.hide();
      this.logger.info('tray: 关闭行为为最小化到托盘，窗口已隐藏');
    }
    // closeBehavior=quit / ask（ask 已由 UI 落定）→ 放行正常关闭
  }
}
