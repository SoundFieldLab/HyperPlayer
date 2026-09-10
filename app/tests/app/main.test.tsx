import { act, screen, waitFor } from '@testing-library/react';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  exitComplete: undefined as (() => void) | undefined,
}));

vi.mock('../../src/app/boot', () => ({
  BootTimeoutError: class BootTimeoutError extends Error {},
  bootApplication: vi.fn().mockResolvedValue({ services: {} }),
  disposeServices: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/app/providers/ServicesProvider', () => ({
  ServicesProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../../src/app/ThemeSynchronizer', () => ({ ThemeSynchronizer: () => null }));
vi.mock('../../src/shell/AppShell', () => ({
  AppShell: () => <main aria-label="主界面" />,
  LimitedShell: () => <main aria-label="受限模式" />,
}));

vi.mock('motion/react', () => ({
  useReducedMotion: () => false,
  motion: {
    main: ({ initial: _initial, animate: _animate, transition: _transition, onAnimationComplete, ...props }: ComponentPropsWithoutRef<'main'> & { onAnimationComplete?: () => void; initial?: unknown; animate?: unknown; transition?: unknown }) => {
      state.exitComplete = onAnimationComplete;
      return <main {...props} />;
    },
    section: ({ initial: _initial, animate: _animate, transition: _transition, ...props }: ComponentPropsWithoutRef<'section'> & { initial?: unknown; animate?: unknown; transition?: unknown }) => <section {...props} />,
  },
}));

import { errorMessage } from '../../src/shared/errors';

describe('startup error formatting', () => {
  it('preserves Tauri string and object rejection messages', () => {
    expect(errorMessage('plugin initialization failed')).toBe('plugin initialization failed');
    expect(errorMessage({ message: 'stronghold client missing' })).toBe('stronghold client missing');
    expect(errorMessage({ error: 'sql load denied' })).toBe('sql load denied');
  });
});

describe('RootApp splash handoff', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    state.exitComplete = undefined;
  });

  it('mounts the main shell only after the ready exit animation completes', async () => {
    await import('../../src/app/main');

    await waitFor(() => expect(screen.getByLabelText('HyperPlayer 正在启动')).toHaveAttribute('data-status', 'ready'));
    expect(screen.queryByLabelText('主界面')).not.toBeInTheDocument();

    act(() => state.exitComplete?.());

    expect(await screen.findByLabelText('主界面')).toBeInTheDocument();
    expect(screen.queryByLabelText('HyperPlayer 正在启动')).not.toBeInTheDocument();
  });
});
