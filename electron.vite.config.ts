import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import pkg from './package.json';

export default defineConfig({
  main: {
    // Bundled because the terminal worker runs from app.asar.unpacked, where app.asar's node_modules can't be resolved.
    plugins: [externalizeDepsPlugin({ exclude: ['@xterm/headless'] })],
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared'), '@engine': resolve(__dirname, 'src/engine') },
    },
    // @xterm/headless's "module" field names a file the package doesn't ship.
    ssr: { resolve: { mainFields: ['main'] } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Runs the terminal emulation off the main thread (see terminal-host.ts).
          'terminal-worker': resolve(__dirname, 'src/engine/terminal-worker.ts'),
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
    // electron-vite's renderer default is no minification; phones download this bundle.
    build: { minify: 'esbuild', cssMinify: true },
  },
});
