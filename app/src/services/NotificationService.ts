/**
 * NotificationService —— 桌面通知业务（后端补充规划 #43）。
 *
 * 触发点：切歌通知（settings.notifyOnTrackChange，默认关）+ 更新可用通知（Phase 6 接入）；
 * 下载完成通知待 B2（显式下载 #18）。
 * 权限守卫：不支持或未授权时静默跳过，不打扰播放。
 */
import type { Notifications } from '../infra/notifications';
import type { SettingsService } from './SettingsService';
import type { QueueItem } from '../domains/player/types';
import type { Logger } from '../shared/logger';
import { createNullLogger } from '../shared/logger';

export interface NotificationServiceDeps {
  notifications: Notifications;
  settings: SettingsService;
  logger?: Logger;
}

export class NotificationService {
  private readonly deps: NotificationServiceDeps;
  private readonly logger: Logger;
  private permissionReady: boolean | null = null;

  constructor(deps: NotificationServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createNullLogger();
  }

  /** 切歌通知（设置开关守卫；不改变播放状态）。 */
  async notifyTrackChange(track: QueueItem | null): Promise<void> {
    if (!this.deps.settings.snapshot.notifyOnTrackChange) return;
    if (!track) return;
    const meta = [track.artist, track.album].filter(Boolean).join(' — ') || undefined;
    await this.notify(track.title, meta);
  }

  /** 通用通知（权限守卫：不支持/未授权静默跳过）。 */
  async notify(title: string, body?: string): Promise<void> {
    if (this.permissionReady === null) {
      if (!(await this.deps.notifications.isSupported())) {
        this.logger.debug('notification: 系统不支持，跳过');
        this.permissionReady = false;
        return;
      }
      this.permissionReady = await this.deps.notifications.ensurePermission();
    }
    if (!this.permissionReady) return;
    await this.deps.notifications.send(title, body);
  }
}
