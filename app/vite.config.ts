import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const neteaseVendor = /vendor[\\/]netease-cloudmusic-api[\\/]/;

function enforceReleaseTokenGate(): Plugin {
  return {
    name: 'hyperplayer-release-token-gate',
    apply: 'build',
    generateBundle(_, bundle) {
      const forbidden = /\brequire\s*\(|\bmodule\.exports\b|\bprocess\.env\b|@neteasecloudmusicapienhanced[\\/]unblockmusic-utils|@unblockneteasemusic/;
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        const match = forbidden.exec(output.code);
        if (match) this.error(`${output.fileName} contains forbidden release token: ${match[0]}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), enforceReleaseTokenGate()],
  clearScreen: false,
  // metadataWorker 依赖 music-metadata 需 code-splitting，worker 用 ESM 格式
  worker: { format: 'es' },
  build: {
    commonjsOptions: {
      // pnpm workspace 将该包链接到 vendor，需同时转换真实路径与普通依赖。
      include: [/node_modules/, neteaseVendor],
    },
  },
});
