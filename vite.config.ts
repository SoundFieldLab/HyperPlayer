import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  // hypersoundengine 是 link: 包且自带 node_modules（tarball 解包），其 ui TSX
  // 就近解析会拿到 HSE 自己那份 react → Invalid hook call（DSP 页白屏）。
  // 强制全图 react/react-dom 归一到应用根实例。
  resolve: { dedupe: ["react", "react-dom"] },
  test: { environment: "jsdom", include: ["app/**/*.test.{ts,tsx}"] },
});
