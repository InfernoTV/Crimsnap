import { defineConfig } from "vite";
import { resolve } from "node:path";

// Tauri expects a fixed port and a multi-page build (main UI + selection overlay).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  // Tauri watches src-tauri itself; ignore it so the dev server doesn't loop.
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "overlay.html"),
      },
    },
  },
});
