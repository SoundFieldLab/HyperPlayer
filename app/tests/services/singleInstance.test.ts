import { describe, expect, it, vi } from 'vitest';
import { createFakeSingleInstance, createFakeWindowControl } from '../../src/infra/fakes';

describe('singleInstance 接线（后端补充规划 #40）', () => {
  it('二次启动：聚焦主窗口 + 载荷透传回调', async () => {
    const control = createFakeWindowControl();
    // 模拟 wiring 中 createTauriSingleInstance 的行为：监听事件 → 聚焦 + 回调
    const single = createFakeSingleInstance();
    const onPayload = vi.fn();
    const unbind = await single.onSecondInstance((payload) => {
      void control.setFocus();
      onPayload(payload);
    });
    single.trigger({ args: ['C:\\music\\a.mp3'], cwd: 'C:\\' });
    expect(control.calls).toContain('setFocus');
    expect(onPayload).toHaveBeenCalledWith({ args: ['C:\\music\\a.mp3'], cwd: 'C:\\' });
    unbind();
    single.trigger({ args: [], cwd: '' });
    expect(onPayload).toHaveBeenCalledTimes(1);
  });
});
