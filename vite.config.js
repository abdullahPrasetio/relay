import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import fs from 'node:fs';
import path from 'node:path';

// Copies hand-written CommonJS files (preload + script runner) into
// dist-electron so Electron can load them. The main bundle requires
// ./script-runner.cjs at runtime, and the preload must stay CommonJS.
// Runs on both dev server start and production build.
function copyPreload() {
  const outDir = path.resolve(__dirname, 'dist-electron');
  const files = ['preload.cjs']; // script runner is now bundled into main.js
  const copy = () => {
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of files) {
      fs.copyFileSync(path.resolve(__dirname, 'electron', f), path.join(outDir, f));
    }
  };
  return {
    name: 'copy-electron-cjs',
    buildStart: copy,
    configureServer: copy,
  };
}

// Mirrors Postman's split: a Node-side "main" process that runs the
// network engine, a sandboxed "preload" context bridge, and the React
// renderer that is pure UI.
export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        // Main process: owns windows + the HTTP request engine.
        entry: 'electron/main.js',
      },
    ]),
    renderer(),
    // The preload must be CommonJS because Electron cannot load an ESM
    // preload, but this package is "type": "module" and vite-plugin-electron
    // forces ESM output for every entry. So we skip bundling it and copy the
    // hand-written .cjs (which only uses require('electron')) into the output.
    copyPreload(),
  ],
  build: {
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        // Split heavy, rarely-changing libraries into their own chunks so the
        // app bundle stays small and chunks cache well. Monaco is the big one.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('monaco-editor')) return 'monaco';
            if (id.includes('react') || id.includes('scheduler')) return 'react-vendor';
            return 'vendor';
          }
        },
      },
    },
  },
});
