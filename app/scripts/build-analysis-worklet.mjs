// HyperPlayer 构建辅助：打包分析 tap worklet 为 classic script（供 audioWorklet.addModule）。
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outfile = join(root, 'app', 'public', 'worklet', 'analysis-tap.js');
mkdirSync(dirname(outfile), { recursive: true });

await build({
  entryPoints: [join(root, 'app', 'src', 'domains', 'player', 'analysis-tap.worklet.ts')],
  bundle: true,
  outfile,
  format: 'iife',
  target: 'es2022',
  logLevel: 'info',
});

console.log('analysis tap worklet -> app/public/worklet/analysis-tap.js');
