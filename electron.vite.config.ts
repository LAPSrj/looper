import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import pkg from './package.json';

/** `import url from 'x.wasm?inline'`: the file as a data URL, which Vite's assets don't do in the main process's build. */
const inlineFiles = (): Plugin => ({
  name: 'looper-inline-files',
  enforce: 'pre',
  resolveId: (id) => (id.endsWith('?inline') ? `\0inline:${createRequire(__filename).resolve(id.slice(0, -'?inline'.length))}` : null),
  load: (id) => (id.startsWith('\0inline:') ? `export default ${JSON.stringify(`data:application/wasm;base64,${readFileSync(id.slice('\0inline:'.length)).toString('base64')}`)}` : null),
});

export default defineConfig({
  main: {
    // Bundled: @xterm/headless and pngjs because the terminal and thumbnail workers run from app.asar.unpacked,
    // where app.asar's node_modules can't be resolved; zod because its own build loads all 95 files and 64
    // languages (100 ms, 10 MB) where the bundle keeps the parts Looper uses. Left out: koffi, a dev dependency
    // with native code that only the perf scripts' quiet mode loads (platform/perf-quiet.ts).
    plugins: [inlineFiles(), externalizeDepsPlugin({ include: ['koffi'], exclude: ['@xterm/headless', 'pngjs', 'zod'] })],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared'), '@engine': resolve(__dirname, 'src/engine') },
    },
    // @xterm/headless's "module" field names a file the package doesn't ship.
    ssr: { resolve: { mainFields: ['main'] } },
    build: {
      rollupOptions: {
        input: {
          // The entry turns on the compile cache, then loads the app (boot.ts).
          index: resolve(__dirname, 'src/main/boot.ts'),
          app: resolve(__dirname, 'src/main/index.ts'),
          // Runs the terminal emulation off the main thread (see terminal-host.ts).
          'terminal-worker': resolve(__dirname, 'src/engine/terminal-worker.ts'),
          // Makes image thumbnails off the main thread (see thumbnails.ts).
          'thumbnail-worker': resolve(__dirname, 'src/main/thumbnail-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: [
        { find: '@shared', replacement: resolve(__dirname, 'src/shared') },
        // React's production build never calls a Profiler's onRender; the frame watchdog needs it (perf.tsx).
        { find: /^react-dom\/client$/, replacement: 'react-dom/profiling' },
      ],
    },
    // A phone page compares this with the server's version to tell it is out of date.
    define: { __LOOPER_VERSION__: JSON.stringify(pkg.version) },
    // Vite 7's dev server moves @silurus/ooxml's .wasm files out from beside its code, which then can't find them.
    optimizeDeps: { exclude: ['@silurus/ooxml'] },
    // electron-vite's renderer default is no minification; phones download this bundle.
    // LOOPER_NO_MINIFY=1: readable function names in a CPU profile (scripts/perf/bench.mjs, BENCH_PROFILE).
    build: { minify: process.env.LOOPER_NO_MINIFY ? false : 'esbuild', cssMinify: true },
  },
});
