import { describe, expect, it, beforeEach } from 'vitest';
import { NotificationService } from '../../src/services/NotificationService';
import { SettingsService } from '../../src/services/SettingsService';
import { createFakeStore, createFakeNotifications } from '../../src/infra/fakes';
import type { QueueItem } from '../../src/domains/player/types';
import { createNullLogger } from '../../src/shared/logger';

function makeTrack(id: string, title: string, artist?: string): QueueItem {
  const track: QueueItem = { id, title, source: 'netease', entitlement: 'free', cacheStatus: 'none' };
  if (artist) track.artist = artist;
  return track;
}

function makeContext() {
  const store = createFakeStore();
  const settings = new SettingsService({ store, logger: createNullLogger() });
  const notifications = createFakeNotifications();
  const service = new NotificationService({ notifications, settings, logger: createNullLogger() });
  return { settings, notifications, service };
}

describe('NotificationService（后端补充规划 #43）', () => {
  beforeEach(async () => {});

  it('切歌通知：开关默认关 → 不发送', async () => {
    const { settings, notifications, service } = makeContext();
    await settings.load();
    expect(settings.snapshot.notifyOnTrackChange).toBe(false);
    await service.notifyTrackChange(makeTrack('t1', '歌名'));
    expect(notifications.sent).toHaveLength(0);
  });

  it('切歌通知：开关开启 → 发送标题与歌手信息；无 track 不发送', async () => {
    const { settings, notifications, service } = makeContext();
    await settings.load();
    await settings.update({ notifyOnTrackChange: true });
    await service.notifyTrackChange(makeTrack('t1', '歌名', '歌手'));
    expect(notifications.sent).toEqual([{ title: '歌名', body: '歌手' }]);
    await service.notifyTrackChange(null);
    expect(notifications.sent).toHaveLength(1);
  });

  it('通用通知：权限被拒 → 静默跳过', async () => {
    const { notifications, service } = makeContext();
    notifications.setPermission(false);
    await service.notify('标题', '正文');
    expect(notifications.sent).toHaveLength(0);
  });

  it('通用通知：系统不支持 → 静默跳过；后续不再重复探测', async () => {
    const { notifications, service } = makeContext();
    notifications.setSupported(false);
    await service.notify('标题');
    await service.notify('标题2');
    expect(notifications.sent).toHaveLength(0);
  });

  it('通用通知：授权通过 → 发送', async () => {
    const { notifications, service } = makeContext();
    await service.notify('标题', '正文');
    expect(notifications.sent).toEqual([{ title: '标题', body: '正文' }]);
  });
});
