import { motion, useReducedMotion } from 'motion/react';

interface SplashScreenProps {
  status: 'booting' | 'ready' | 'error' | 'timeout';
  message?: string;
  onRetry?: () => void;
  onContinue?: () => void;
  onExitComplete?: () => void;
}

export function SplashScreen({ status, message, onRetry, onContinue, onExitComplete }: SplashScreenProps) {
  const reducedMotion = useReducedMotion();
  const leaving = status === 'ready';

  return (
    <motion.main
      className={`splash ${leaving ? 'splash--leaving' : ''}`}
      aria-label="HyperPlayer 正在启动"
      data-status={status}
      initial={{ opacity: 1 }}
      animate={{ opacity: leaving ? 0 : 1, y: reducedMotion || !leaving ? 0 : -12 }}
      transition={{ duration: reducedMotion ? 0.2 : 0.4, ease: 'easeOut' }}
      onAnimationComplete={() => {
        if (leaving) onExitComplete?.();
      }}
    >
      <motion.section
        className="splash__content"
        initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reducedMotion ? 0.2 : 0.4, ease: 'easeOut' }}
      >
        <img className="splash__logo" src="/logo.png" alt="" aria-hidden="true" />
        <h1 className="splash__title">HyperPlayer</h1>
        {status === 'booting' && <p className="splash__message">{message ?? '正在启动…'}</p>}
        {(status === 'error' || status === 'timeout') && (
          <div className="splash__actions">
            <p className="splash__message" role="alert">{message ?? '启动遇到问题'}</p>
            <div className="splash__buttons">
              <button type="button" className="hp-button hp-button--primary" onClick={onRetry}>重试</button>
              <button type="button" className="hp-button" onClick={onContinue}>以受限模式继续</button>
            </div>
          </div>
        )}
      </motion.section>
    </motion.main>
  );
}
