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
    alias: { vscode: resolve(__dirname, "src/test/vscode.mock.ts") },
    environment: "jsdom",
    globals: true,
    include: ["src/test/**/*.test.ts", "src/test/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        statements: 60,
        branches: 55,
        functions: 60,
        lines: 65
      }
    }
  }
});
