import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // metadataWorker 依赖 music-metadata 需 code-splitting，worker 用 ESM 格式
  worker: { format: 'es' },
});
