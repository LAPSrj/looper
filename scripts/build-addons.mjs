// Builds the addons that come with Looper (src/addons/<id>/): each one's
// main.ts bundled into addon.js (and any other programs it runs, PROGRAMS),
// its manifest written as addon.json, and all zipped into
// out/addons/<id>.looperaddon with addon.json at its root.
//
//   node scripts/build-addons.mjs [--out <folder>]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { strToU8, zipSync } from 'fflate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ADDONS = ['git'];
/** Each addon's other programs, bundled next to addon.js: the file name in the package and its source in the addon's folder. */
const PROGRAMS = { git: { 'askpass.js': 'askpass-client.ts' } };

/** The manifest manifest.ts exports, read by bundling it on its own (its imports are types only). */
async function readManifest(id) {
  const out = await build({
    entryPoints: [path.join(ROOT, 'src/addons', id, 'manifest.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  return mod.MANIFEST;
}

/** Build one addon into `outDir`; resolves with its package's path and size. */
export async function buildAddon(id, outDir = path.join(ROOT, 'out', 'addons')) {
  const dir = path.join(outDir, id);
  await mkdir(dir, { recursive: true });
  const programs = { 'addon.js': 'main.ts', ...(PROGRAMS[id] ?? {}) };
  const files = {};
  for (const [name, source] of Object.entries(programs)) {
    const js = path.join(dir, name);
    await build({
      entryPoints: [path.join(ROOT, 'src/addons', id, source)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      minify: false,
      outfile: js,
      logLevel: 'warning',
    });
    files[name] = await readFile(js);
  }
  const manifest = `${JSON.stringify(await readManifest(id), null, 2)}\n`;
  await writeFile(path.join(dir, 'addon.json'), manifest);
  const zip = zipSync({ 'addon.json': strToU8(manifest), ...files }, { level: 9 });
  const pkg = path.join(outDir, `${id}.looperaddon`);
  await writeFile(pkg, zip);
  return { id, dir, package: pkg, bytes: zip.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--out');
  const outDir = at > 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : undefined;
  for (const id of ADDONS) {
    const built = await buildAddon(id, outDir);
    console.log(`${path.relative(process.cwd(), built.package)}: ${(built.bytes / 1024).toFixed(1)} kB`);
  }
}
