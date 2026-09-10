import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SplashScreen } from '../../src/app/providers/SplashScreen';

const motionState = vi.hoisted(() => ({
  reducedMotion: false,
  mainProps: undefined as Record<string, unknown> | undefined,
}));

vi.mock('motion/react', () => ({
  useReducedMotion: () => motionState.reducedMotion,
  motion: {
    main: ({ initial, animate, transition, onAnimationComplete, ...props }: ComponentPropsWithoutRef<'main'> & Record<string, unknown>) => {
      motionState.mainProps = { initial, animate, transition, onAnimationComplete };
      return <main {...props} />;
    },
    section: ({ initial: _initial, animate: _animate, transition: _transition, ...props }: ComponentPropsWithoutRef<'section'> & Record<string, unknown>) => <section {...props} />,
  },
}));

describe('SplashScreen', () => {
  beforeEach(() => {
    motionState.reducedMotion = false;
    motionState.mainProps = undefined;
  });

  it('uses the official logo and white text hierarchy without a substitute icon', () => {
    render(<SplashScreen status="booting" message="正在初始化" />);

    expect(screen.getByRole('heading', { name: 'HyperPlayer' })).toBeInTheDocument();
    expect(document.querySelector('.splash__logo')).toHaveAttribute('src', '/logo.png');
    expect(screen.queryByTestId('music-note')).not.toBeInTheDocument();
    expect(screen.getByText('正在初始化')).toHaveClass('splash__message');
  });

  it.each(['timeout', 'error'] as const)('keeps the splash visible for %s until the user chooses an action', (status) => {
    const onRetry = vi.fn();
    const onContinue = vi.fn();
    const onExitComplete = vi.fn();

    render(
      <SplashScreen
        status={status}
        message="启动遇到问题"
        onRetry={onRetry}
        onContinue={onContinue}
        onExitComplete={onExitComplete}
      />,
    );

    expect(motionState.mainProps?.animate).toEqual({ opacity: 1, y: 0 });
    act(() => {
      (motionState.mainProps?.onAnimationComplete as (() => void) | undefined)?.();
    });
    expect(onExitComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    fireEvent.click(screen.getByRole('button', { name: '以受限模式继续' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('finishes a ready exit only after its animation completes', () => {
    const onExitComplete = vi.fn();
    render(<SplashScreen status="ready" onExitComplete={onExitComplete} />);

    expect(onExitComplete).not.toHaveBeenCalled();
    expect(motionState.mainProps?.animate).toEqual({ opacity: 0, y: -12 });
    act(() => {
      (motionState.mainProps?.onAnimationComplete as (() => void) | undefined)?.();
    });
    expect(onExitComplete).toHaveBeenCalledOnce();
  });

  it('uses a 200ms opacity-only exit when reduced motion is enabled', () => {
    motionState.reducedMotion = true;
    render(<SplashScreen status="ready" />);

    expect(motionState.mainProps?.animate).toEqual({ opacity: 0, y: 0 });
    expect(motionState.mainProps?.transition).toMatchObject({ duration: 0.2 });
  });
});
