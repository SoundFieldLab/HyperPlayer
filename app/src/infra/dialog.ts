import { open } from '@tauri-apps/plugin-dialog';

export interface DirectoryDialog {
  pickDirectory(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
}

export function createTauriDirectoryDialog(): DirectoryDialog {
  return {
    async pickDirectory(options = {}) {
      const selected = await open({
        directory: true,
        multiple: false,
        title: options.title,
        defaultPath: options.defaultPath,
      });
      return typeof selected === 'string' ? selected : null;
    },
  };
}
