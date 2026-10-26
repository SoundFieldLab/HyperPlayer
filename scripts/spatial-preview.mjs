import { createServer, build, preview } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const config = { root, configFile: false, base: './', plugins: [tailwindcss()],
  server: { host: '127.0.0.1', port: 3290, strictPort: true, fs: { allow: [root, fileURLToPath(new URL('../node_modules', import.meta.url))] } },
  build: { target: 'es2022', outDir: '.verification/spatial-preview', emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('../spatial-debug.html', import.meta.url)) } } }
if (process.argv.includes('--serve-build')) { const server = await preview({ ...config, preview: { host: '127.0.0.1', port: 3291, strictPort: true } }); server.printUrls() }
else if (process.argv.includes('--build')) await build(config)
else { const server = await createServer(config); await server.listen(); server.printUrls() }
