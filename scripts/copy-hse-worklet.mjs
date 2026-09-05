// HyperPlayer 构建辅助：把 HSE 的 TS worklet 打包产物复制为 app 公共资源，
// 供 host 以 mode:'auto' 加载（tauri 壳内 addModule 需要可寻址的静态 URL）。
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'vendor', 'HyperSoundEngine-v1.5.1-local', 'dist', 'worklet-bundle.js');
const destDir = join(root, 'app', 'public', 'worklet');
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, 'hse-worklet.js');
copyFileSync(source, dest);
console.log(`HSE worklet -> ${dest}`);
