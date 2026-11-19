// Builds the icon library addons can name, from the lucide-static package:
// assets/icon-library.json for the main process, and docs/addon-icon-list.md.
// Run it with `npm run build:icons` after updating the package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSvgIcon } from '../src/shared/addon-icons.ts';
import { ADDON_ICONS } from '../src/shared/addons.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'node_modules', 'lucide-static', 'icons');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'lucide-static', 'package.json'), 'utf8'));

const LOOPER_ICONS = {
  add: 'A plus',
  edit: 'A pencil',
  delete: 'A trash can',
  recycleBin: 'A trash can with slats, for a Recycle Bin of deleted items',
  copy: 'Two overlapping sheets',
  refresh: 'A circular arrow',
  open: 'An arrow out of a box',
  folder: 'A folder, for a button about the folder itself',
  openFolder: 'A folder with its front tipped forward, for a button that opens a folder in Explorer',
  terminal: 'A terminal window',
  run: 'A play triangle',
  stop: 'A stop square',
  pause: 'Two pause bars',
  key: 'A key',
  lock: 'A padlock',
  search: 'A magnifying glass',
  settings: 'A gear',
};
for (const name of ADDON_ICONS) if (!LOOPER_ICONS[name]) throw new Error(`no description for ${name}`);

const names = fs
  .readdirSync(source)
  .filter((f) => f.endsWith('.svg'))
  .map((f) => f.slice(0, -4))
  .sort();

const library = {};
for (const name of names) {
  const svg = parseSvgIcon(fs.readFileSync(path.join(source, `${name}.svg`), 'utf8'));
  if (!svg.ok) throw new Error(`${name}: ${svg.error}`);
  if (svg.drawing.box !== 24 || svg.drawing.fill !== 'none' || svg.drawing.stroke !== 'currentColor') throw new Error(`${name}: drawn differently from the rest`);
  library[name] = svg.drawing.shapes;
}
fs.writeFileSync(path.join(root, 'assets', 'icon-library.json'), JSON.stringify(library));

const byLetter = new Map();
for (const name of names) {
  const letter = /^[a-z]/.test(name) ? name[0].toUpperCase() : '0-9';
  byLetter.set(letter, [...(byLetter.get(letter) ?? []), name]);
}

const page = `# Addon icon list

Every icon an addon can name, for its \`icon\` and \`panesIcon\` fields and a
command's state. [Addon icons](addon-icons.md) says how to choose one and how to
draw your own.

## Looper's icons

Write the name as it is, such as \`"icon": "key"\`.

| Name | Shows |
|---|---|
${ADDON_ICONS.map((name) => `| \`${name}\` | ${LOOPER_ICONS[name]} |`).join('\n')}

## The library

Write \`library:\` and the name, such as \`"icon": "library:rocket"\`. These are the
${names.length} icons of Lucide ${pkg.version} (ISC license), whose website shows what each looks
like: https://lucide.dev/icons

${[...byLetter].map(([letter, list]) => `### ${letter}\n\n${list.map((n) => `\`${n}\``).join(' ')}`).join('\n\n')}
`;
fs.writeFileSync(path.join(root, 'docs', 'addon-icon-list.md'), page);
console.log(`${names.length} icons`);
