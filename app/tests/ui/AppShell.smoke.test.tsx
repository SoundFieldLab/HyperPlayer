import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../../src/shell/AppShell';
import { useAppStore } from '../../src/stores/store';
import { createFakeServices, renderWithServices } from './test-utils';

describe('AppShell UI smoke', () => {
  it('renders the default navigation with the service provider', async () => {
    const services = createFakeServices();
    useAppStore.setState({ activeDomain: 'netease', currentEntry: null });

    renderWithServices(<AppShell />, services);

    expect(document.body).toBeTruthy();
    expect(screen.getByRole('complementary', { name: '主导航' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '首页' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '开始聆听' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开命令面板' })).toBeInTheDocument();

    await waitFor(() => expect(services.audio.listOutputDevices).toHaveBeenCalledTimes(1));
  });
});
