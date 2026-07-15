import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  publicDir: "assets",
  build: {
    outDir: "media",
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      preserveEntrySignatures: "strict",
      input: {
        webview: resolve(__dirname, "src/webviews/main.tsx"),
        notebookRenderer: resolve(__dirname, "src/webviews/notebookRenderer.ts"),
        codePreview: resolve(__dirname, "src/webviews/codePreviewMain.ts")
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]"
      }
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/test/**/*.test.ts", "src/test/**/*.test.tsx"]
  }
});
