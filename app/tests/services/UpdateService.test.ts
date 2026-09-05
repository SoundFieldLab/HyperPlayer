import { describe, expect, it, beforeEach } from 'vitest';
import { UpdateService, UPDATE_TASK_ID } from '../../src/services/UpdateService';
import { TaskCenter } from '../../src/services/TaskCenter';
import { createFakeUpdater } from '../../src/infra/fakes';
import type { AppUpdate } from '../../src/infra/updater';
import { createNullLogger } from '../../src/shared/logger';

function makeUpdate(version: string): AppUpdate {
  return {
    version,
    body: `更新说明 ${version}`,
    downloadAndInstall: async (onProgress) => {
      onProgress?.({ downloaded: 50, total: 100 });
      onProgress?.({ downloaded: 100, total: 100 });
    },
  };
}

function makeContext() {
  const taskCenter = new TaskCenter({ logger: createNullLogger() });
  const updater = createFakeUpdater();
  const service = new UpdateService({ updater, taskCenter, logger: createNullLogger() });
  return { taskCenter, updater, service };
}

describe('UpdateService（后端补充规划 #54）', () => {
  beforeEach(() => {});

  it('无更新：任务 done「已是最新版本」，返回 null', async () => {
    const { taskCenter, updater, service } = makeContext();
    updater.setResult(null);
    const result = await service.checkUpdate();
    expect(result).toBeNull();
    const task = taskCenter.getTask(UPDATE_TASK_ID);
    expect(task?.state).toBe('done');
    expect(task?.detail).toBe('已是最新版本');
    expect(task?.kind).toBe('app-update');
  });

  it('有更新（不自动安装）：任务 done 并提示新版本', async () => {
    const { taskCenter, updater, service } = makeContext();
    updater.setResult(makeUpdate('0.2.0'));
    const result = await service.checkUpdate();
    expect(result?.version).toBe('0.2.0');
    const task = taskCenter.getTask(UPDATE_TASK_ID);
    expect(task?.state).toBe('done');
    expect(task?.detail).toContain('0.2.0');
  });

  it('有更新（自动安装）：下载进度写入任务，完成后 done', async () => {
    const { taskCenter, updater, service } = makeContext();
    updater.setResult(makeUpdate('0.2.0'));
    const result = await service.checkUpdate({ autoInstall: true });
    expect(result?.version).toBe('0.2.0');
    const task = taskCenter.getTask(UPDATE_TASK_ID);
    expect(task?.state).toBe('done');
    expect(task?.progress).toBe(1);
    expect(task?.detail).toContain('已更新到 0.2.0');
  });

  it('更新源未配置/网络失败：任务 failed 并带可读原因，抛错', async () => {
    const { taskCenter, updater, service } = makeContext();
    updater.setError(new Error('updater is not enabled'));
    await expect(service.checkUpdate()).rejects.toThrow('updater is not enabled');
    const task = taskCenter.getTask(UPDATE_TASK_ID);
    expect(task?.state).toBe('failed');
    expect(task?.detail).toContain('更新源未配置');
  });

  it('普通失败：任务 failed 带错误信息', async () => {
    const { taskCenter, updater, service } = makeContext();
    updater.setError(new Error('network timeout'));
    await expect(service.checkUpdate()).rejects.toThrow('network timeout');
    const task = taskCenter.getTask(UPDATE_TASK_ID);
    expect(task?.state).toBe('failed');
    expect(task?.detail).toContain('检查更新失败');
  });
});
