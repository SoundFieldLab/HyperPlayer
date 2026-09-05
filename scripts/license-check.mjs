// HyperPlayer license gate (M0).
//
// Verifies:
//   1. Every production dependency of the app manifest (root + app) is
//      registered in the allowlist below. New dependencies MUST first be
//      registered in THIRD_PARTY_NOTICES.md and added to this allowlist.
//   2. Vendored package manifests never list a hard-denied dependency
//      (AGPL folia / LGPL unblock paths / Electron).
//   3. src-tauri Cargo.toml only uses the declared plugin set (zero custom Rust).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const fail = (message) => {
  console.error(`license-check: FAIL - ${message}`);
  process.exitCode = 1;
};

const appAllowlist = new Set([
  // App runtime deps (all registered in THIRD_PARTY_NOTICES.md).
  'react',
  'react-dom',
  'zustand',
  '@tauri-apps/api',
  '@tauri-apps/plugin-dialog',
  '@tauri-apps/plugin-fs',
  '@tauri-apps/plugin-http',
  '@tauri-apps/plugin-sql',
  '@tauri-apps/plugin-store',
  '@tauri-apps/plugin-stronghold',
  '@tauri-apps/plugin-window-state',
  '@tauri-apps/plugin-global-shortcut',
  '@tauri-apps/plugin-notification',
  '@tauri-apps/plugin-updater',
  '@tauri-apps/plugin-autostart',
  // Vendored workspace packages (covered by their own NOTICES entries).
  'hypersoundengine',
  '@neteasecloudmusicapienhanced/api',
  'music-metadata',
]);

// Hard-denied anywhere in the workspace (AGPL / LGPL unblock paths / Electron).
const hardDeny = new Set([
  'folia',
  '@unblockneteasemusic',
  '@neteasecloudmusicapienhanced/unblockmusic-utils',
  'song_url_match',
  'electron',
]);

const cargoAllowlist = new Set([
  'tauri',
  'tauri-build',
  'tauri-plugin-dialog',
  'tauri-plugin-fs',
  'tauri-plugin-http',
  'tauri-plugin-store',
  'tauri-plugin-sql',
  'tauri-plugin-stronghold',
  'tauri-plugin-window-state',
  'tauri-plugin-global-shortcut',
  'tauri-plugin-notification',
  'tauri-plugin-updater',
  'tauri-plugin-single-instance',
  'tauri-plugin-autostart',
  'serde',
  'serde_json',
]);

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const readTomlDeps = (file) => {
  const text = readFileSync(file, 'utf8');
  const section = text.match(/\[dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (!section) return [];
  const names = [];
  for (const line of section[1].split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
    const name = trimmed.split('=')[0]?.trim() ?? '';
    if (name && !name.startsWith('"')) names.push(name);
  }
  return names;
};

// 1. App manifest production deps (root scripts have no deps; app is the manifest).
const appManifest = readJson(join(root, 'app', 'package.json'));
for (const name of Object.keys(appManifest.dependencies ?? {})) {
  if (hardDeny.has(name)) fail(`app dependency ${name} is hard-denied`);
  else if (!appAllowlist.has(name)) fail(`app dependency ${name} is not registered in the allowlist`);
}
for (const name of Object.keys(appManifest.devDependencies ?? {})) {
  if (hardDeny.has(name)) fail(`app devDependency ${name} is hard-denied`);
}

// 2. Vendored package manifests: hard-deny scan only (registration is covered
//    by their own THIRD_PARTY_NOTICES entries).
const vendorRoot = join(root, 'vendor');
for (const entry of readdirSync(vendorRoot)) {
  const manifest = join(vendorRoot, entry, 'package.json');
  if (!existsSync(manifest)) continue;
  const pkg = readJson(manifest);
  const allDeps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
  for (const name of Object.keys(allDeps)) {
    if (hardDeny.has(name)) fail(`vendored ${pkg.name}: dependency ${name} is hard-denied`);
  }
}

// 3. Rust shell: only the declared plugin set.
const cargoToml = join(root, 'src-tauri', 'Cargo.toml');
if (existsSync(cargoToml)) {
  for (const name of readTomlDeps(cargoToml)) {
    if (!cargoAllowlist.has(name)) fail(`Cargo dependency ${name} is not in the shell allowlist`);
  }
}

if (process.exitCode) {
  console.error('license-check: FAILED — register new dependencies in THIRD_PARTY_NOTICES.md first.');
  process.exit(1);
}
console.log('license-check: OK — all dependency names are covered.');
