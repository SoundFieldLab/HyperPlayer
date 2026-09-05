/**
 * ShortcutService —— 全局快捷键绑定管理（后端补充规划 #7/#8）。
 *
 * - 默认绑定媒体键（SMTC 缺席下的回退）：MediaPlayPause / MediaTrackNext / MediaTrackPrevious
 *   → PlayerController 命令（UI-D24"媒体键交系统"在 SMTC 缺席时以全局快捷键承接）；
 * - settings.shortcuts 可覆盖/禁用（空串 = 禁用该动作）；
 * - 冲突检测：应用内同键多动作、系统注册失败（被占用/非法组合）均记入 conflicts。
 */
import type { Shortcuts, ShortcutEvent } from '../infra/shortcuts';
import type { SettingsService } from './SettingsService';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export type ShortcutAction = 'playPause' | 'next' | 'prev';

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  playPause: 'MediaPlayPause',
  next: 'MediaTrackNext',
  prev: 'MediaTrackPrevious',
};

export interface ShortcutCommands {
  playPause: () => void | Promise<void>;
  next: () => void | Promise<void>;
  prev: () => void | Promise<void>;
}

export interface ShortcutServiceDeps {
  shortcuts: Shortcuts;
  settings: SettingsService;
  commands: ShortcutCommands;
  logger?: Logger;
}

export interface ShortcutSnapshot {
  /** 当前生效绑定（settings 覆盖合并默认后）。 */
  bindings: Partial<Record<ShortcutAction, string>>;
  /** 冲突/注册失败的快捷键（应用内重复或系统占用）。 */
  conflicts: string[];
}

export class ShortcutService {
  private readonly deps: ShortcutServiceDeps;
  private readonly logger: Logger;
  private readonly registered = new Map<string, ShortcutAction>();
  private conflicts: string[] = [];

  constructor(deps: ShortcutServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
  }

  /** 启动注册（wiring 调用）。 */
  async init(): Promise<void> {
    await this.rebind();
  }

  /** 按 settings 重算绑定并重注册（设置变更后调用）。 */
  async rebind(): Promise<void> {
    for (const shortcut of this.registered.keys()) {
      await this.deps.shortcuts.unregister(shortcut);
    }
    this.registered.clear();
    this.conflicts = [];

    const bindings = this.resolveBindings();
    for (const [action, shortcut] of Object.entries(bindings) as Array<[ShortcutAction, string | undefined]>) {
      if (!shortcut) continue; // 空串 = 禁用该动作
      if (this.registered.has(shortcut)) {
        this.conflicts.push(shortcut);
        this.logger.warn(`shortcut: ${shortcut} 重复绑定 ${action}，跳过`);
        continue;
      }
      const ok = await this.deps.shortcuts.register(shortcut, (event) => this.handlePress(action, event));
      if (!ok) {
        this.conflicts.push(shortcut);
        this.logger.warn(`shortcut: ${shortcut} 注册失败（被占用/非法组合），跳过`);
        continue;
      }
      this.registered.set(shortcut, action);
    }
    this.logger.info(`shortcut: 生效 ${this.registered.size} 个绑定，冲突 ${this.conflicts.length} 个`);
  }

  getSnapshot(): ShortcutSnapshot {
    const bindings: Partial<Record<ShortcutAction, string>> = {};
    for (const [shortcut, action] of this.registered) bindings[action] = shortcut;
    return { bindings, conflicts: [...this.conflicts] };
  }

  /** 全部卸载（应用退出）。 */
  async dispose(): Promise<void> {
    await this.deps.shortcuts.unregisterAll();
    this.registered.clear();
    this.conflicts = [];
  }

  private handlePress(action: ShortcutAction, event: ShortcutEvent): void {
    if (event.state !== 'Pressed') return;
    void Promise.resolve(this.deps.commands[action]()).catch((error) => {
      this.logger.warn(`shortcut: ${action} 命令执行失败`, error);
    });
  }

  private resolveBindings(): Partial<Record<ShortcutAction, string>> {
    const overrides = this.deps.settings.snapshot.shortcuts ?? {};
    const bindings: Partial<Record<ShortcutAction, string>> = { ...DEFAULT_SHORTCUTS };
    for (const action of Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[]) {
      const override = overrides[action];
      if (override !== undefined) bindings[action] = override;
    }
    return bindings;
  }
}
