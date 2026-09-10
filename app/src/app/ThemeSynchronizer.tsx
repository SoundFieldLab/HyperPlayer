import { useEffect } from 'react';
import { useAppStore } from '../stores/store';

export function ThemeSynchronizer() {
  const theme = useAppStore((state) => state.settings.theme);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
      localStorage.setItem('hyperplayer.theme', resolved);
    };
    apply();
    if (theme !== 'system') return undefined;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  return null;
}
