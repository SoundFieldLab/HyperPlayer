/**
 * UpdateService —— 应用更新业务闭环（后端补充规划 #54，M6）。
 *
 * check → TaskCenter 'app-update' 任务（补上此前空壳的任务种类）：
 * - 无更新：任务 done"已是最新版本"；
 * - 有更新：可自动下载安装（Windows 安装完成后自动重启）或仅提示；
 * - 更新源未配置/网络失败：任务 failed 并带可读原因（发布构建后可用）。
 */
import type { Updater, AppUpdate } from '../infra/updater';
import type { TaskCenter } from './TaskCenter';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export const UPDATE_TASK_ID = 'app-update:check';

export interface UpdateServiceDeps {
  updater: Updater;
  taskCenter: TaskCenter;
  logger?: Logger;
}

export class UpdateService {
  private readonly deps: UpdateServiceDeps;
  private readonly logger: Logger;

  constructor(deps: UpdateServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
  }

  /** 检查并（可选）自动安装；返回可用更新（无更新返回 null）；失败抛错并落任务。 */
  async checkUpdate(opts: { autoInstall?: boolean } = {}): Promise<AppUpdate | null> {
    const taskCenter = this.deps.taskCenter;
    taskCenter.register({ id: UPDATE_TASK_ID, kind: 'app-update', title: '检查更新', actions: ['retry', 'view'] });
    taskCenter.update(UPDATE_TASK_ID, { detail: '正在检查更新…' });
    try {
      const update = await this.deps.updater.check();
      if (!update) {
        taskCenter.complete(UPDATE_TASK_ID, 'done', '已是最新版本');
        return null;
      }
      taskCenter.update(UPDATE_TASK_ID, { detail: `发现新版本 ${update.version}，正在下载…` });
      if (opts.autoInstall) {
        await update.downloadAndInstall((progress) => {
          const total = progress.total;
          const percent = total && total > 0 ? Math.min(1, progress.downloaded / total) : undefined;
          const detail = total ? `${Math.round((progress.downloaded / total) * 100)}%` : `已下载 ${progress.downloaded} 字节`;
          taskCenter.update(UPDATE_TASK_ID, { progress: percent, detail: `下载更新 ${detail}` });
        });
        taskCenter.complete(UPDATE_TASK_ID, 'done', `已更新到 ${update.version}`);
        this.logger.info(`updater: 安装完成 ${update.version}`);
      } else {
        taskCenter.complete(UPDATE_TASK_ID, 'done', `发现新版本 ${update.version}`);
      }
      return update;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const notConfigured = /disabled|not enabled|endpoint|pubkey|config/i.test(message);
      const detail = notConfigured ? '更新源未配置（发布构建后可用）' : `检查更新失败：${message}`;
      taskCenter.complete(UPDATE_TASK_ID, 'failed', detail);
      this.logger.warn(`updater: ${detail}`);
      throw error;
    }
  }

  /** 状态中心重试动作：重新检查。 */
  async retry(): Promise<void> {
    await this.checkUpdate();
  }
}
