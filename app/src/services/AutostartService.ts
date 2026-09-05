/**
 * AutostartService —— 开机自启业务（后端补充规划 #39，M6）。
 *
 * 设置项 autostart（默认关）与系统实际状态双向同步：
 * 启动时对齐（防外部篡改/首次接线），setAutostart 供设置页调用。
 */
import type { Autostart } from '../infra/autostart';
import type { SettingsService } from './SettingsService';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export interface AutostartServiceDeps {
  autostart: Autostart;
  settings: SettingsService;
  logger?: Logger;
}

export class AutostartService {
  private readonly deps: AutostartServiceDeps;
  private readonly logger: Logger;
  /** 上次已拉齐的期望值：未变化时跳过 IPC 探测（设置高频更新不空转）。 */
  private syncedWant: boolean | null = null;

  constructor(deps: AutostartServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
  }

  /** 启动时与系统状态对齐（wiring 调用；期望值未变时跳过）。 */
  async init(): Promise<void> {
    const want = this.deps.settings.snapshot.autostart === true;
    if (this.syncedWant === want) return;
    const actual = await this.deps.autostart.isEnabled();
    if (want === actual) {
      this.syncedWant = want;
      return;
    }
    const ok = want ? await this.deps.autostart.enable() : await this.deps.autostart.disable();
    this.syncedWant = want;
    this.logger.info(`autostart: 启动对齐 ${want ? '启用' : '停用'}（${ok ? '成功' : '失败'}）`);
  }

  /** 设置页入口：写设置并立即应用到系统。 */
  async setAutostart(enabled: boolean): Promise<boolean> {
    const ok = enabled ? await this.deps.autostart.enable() : await this.deps.autostart.disable();
    if (ok) {
      await this.deps.settings.update({ autostart: enabled });
      this.syncedWant = enabled;
    } else {
      this.logger.warn(`autostart: 系统 ${enabled ? '启用' : '停用'} 失败，设置未落盘`);
    }
    return ok;
  }
}
