// The app's build, plus a report of the largest modules in each renderer chunk:
// `npx electron-vite build -c scripts/perf/bundle-report.config.ts` (writes the normal out/).
import type { Plugin } from 'vite';
import config from '../../electron.vite.config';

const report: Plugin = {
  name: 'bundle-report',
  generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk' || chunk.code.length < 50_000) continue;
      const byPackage = new Map<string, number>();
      for (const [id, m] of Object.entries(chunk.modules)) {
        const key = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id)?.[1] ?? id.replace(/^.*\/src\//, 'src/');
        byPackage.set(key, (byPackage.get(key) ?? 0) + m.renderedLength);
      }
      console.log(`\n${chunk.fileName} ${Math.round(chunk.code.length / 1024)} kB`);
      for (const [k, n] of [...byPackage].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(Math.round(n / 1024)).padStart(5)} kB  ${k}`);
    }
  },
};

export default { ...config, renderer: { ...config.renderer, plugins: [...(config.renderer?.plugins ?? []), report] } };
