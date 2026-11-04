// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import type { DialogResult, FileDialogSpec, FileFilterSpec, HostDirEntry, HostPlace } from '../../../shared/remote-access';

// ---------- message boxes ----------

export const messageResult = (response: number, checkboxChecked: boolean): DialogResult => ({ kind: 'message', response, checkboxChecked });

// ---------- file dialogs ----------

export type FileDialogKind = 'open' | 'save';
/** Where the file is: on the computer Looper runs on, or on the device the browser runs on. */
export type FileSource = 'computer' | 'device';

export const openCanceled: DialogResult = { kind: 'open', canceled: true, filePaths: [] };
export const saveCanceled: DialogResult = { kind: 'save', canceled: true };

export const openResult = (paths: string[]): DialogResult => (paths.length ? { kind: 'open', canceled: false, filePaths: paths } : openCanceled);
export const saveToComputer = (filePath: string): DialogResult => ({ kind: 'save', canceled: false, filePath });
/** The computer writes the file, then sends it as a download named `name`. */
export const saveToDevice = (name: string): DialogResult => ({ kind: 'save', canceled: false, deliver: true, filePath: name });

const has = (spec: FileDialogSpec, p: string): boolean => spec.properties?.includes(p) ?? false;
export const picksFolders = (spec: FileDialogSpec): boolean => has(spec, 'openDirectory');
export const picksMany = (spec: FileDialogSpec): boolean => has(spec, 'multiSelections');

/** The sources a dialog offers: a folder means something only on the computer. */
export function fileSources(kind: FileDialogKind, spec: FileDialogSpec): FileSource[] {
  return kind === 'open' && picksFolders(spec) ? ['computer'] : ['computer', 'device'];
}

export const sourceKey = (kind: FileDialogKind): string => `looper.fileSource.${kind}`;

/** The source the dialog opens on: the one last used for its kind, when it offers it. */
export function initialSource(kind: FileDialogKind, spec: FileDialogSpec, remembered: string | null): FileSource {
  const offered = fileSources(kind, spec);
  return offered.includes(remembered as FileSource) ? (remembered as FileSource) : offered[0];
}

/** The extensions the filters allow, lowercase without the dot; null = any file. */
export function allowedExtensions(filters: FileFilterSpec[] | undefined): string[] | null {
  if (!filters?.length) return null;
  const exts = filters.flatMap((f) => f.extensions.map((e) => e.replace(/^\./, '').toLowerCase()));
  return exts.length === 0 || exts.includes('*') ? null : [...new Set(exts)];
}

/** `accept` for an <input type=file>: ".loopertask,.md"; undefined = any file. */
export function acceptAttr(filters: FileFilterSpec[] | undefined): string | undefined {
  const exts = allowedExtensions(filters);
  return exts ? exts.map((e) => `.${e}`).join(',') : undefined;
}

export const extensionOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** A listing as the dialog shows it: folders always, files only when they can be picked and the filters allow them. */
export function visibleEntries(entries: HostDirEntry[], opts: { files: boolean; extensions: string[] | null }): HostDirEntry[] {
  return entries.filter((e) => e.dir || (opts.files && (!opts.extensions || opts.extensions.includes(extensionOf(e.name)))));
}

/** "Looper Task (*.loopertask)", as the filter line under the file name shows it. */
export function filterLabel(filters: FileFilterSpec[] | undefined): string {
  if (!filters?.length) return 'All files (*.*)';
  return filters.map((f) => `${f.name} (${f.extensions.map((e) => (e === '*' ? '*.*' : `*.${e}`)).join(', ')})`).join('; ');
}

/** Save As adds the filter's extension when the name has none of the allowed ones, as Windows does. */
export function withExtension(name: string, filters: FileFilterSpec[] | undefined): string {
  const exts = allowedExtensions(filters);
  if (!exts || exts.includes(extensionOf(name))) return name;
  return `${name}.${exts[0]}`;
}

const isWindowsPath = (p: string): boolean => /^[A-Za-z]:/.test(p) || p.startsWith('\\\\');
const sepOf = (p: string): string => (isWindowsPath(p) ? '\\' : '/');

export function joinPath(dir: string, name: string): string {
  const sep = sepOf(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** defaultPath split: the folder to start in (null = the starting places) and the name to fill in. */
export function splitDefaultPath(p: string | undefined): { dir: string | null; name: string } {
  if (!p) return { dir: null, name: '' };
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  if (i < 0) return { dir: null, name: p };
  const dir = p.slice(0, i + 1);
  // "C:\" and "/" stay roots; any other folder loses its trailing separator.
  const trimmed = /^[A-Za-z]:\\$/.test(dir) || dir === '/' || /^\\\\[^\\]+\\[^\\]+\\$/.test(dir) ? dir : dir.slice(0, -1);
  return { dir: trimmed, name: p.slice(i + 1) };
}

export interface Crumb {
  label: string;
  /** null: the starting places ("Host Computer"). */
  path: string | null;
}

/** What the file browser calls the computer Looper runs on, apart from the device the browser runs on. */
export const HOST_COMPUTER = 'Host Computer';

/** The path as clickable parts, after "Host Computer". */
export function breadcrumbs(p: string | null): Crumb[] {
  const out: Crumb[] = [{ label: HOST_COMPUTER, path: null }];
  if (!p) return out;
  if (isWindowsPath(p)) {
    const unc = /^(\\\\[^\\]+\\[^\\]+)(\\.*)?$/.exec(p);
    const drive = /^([A-Za-z]:)(\\.*)?$/.exec(p);
    const root = unc ? `${unc[1]}\\` : drive ? `${drive[1]}\\` : p;
    out.push({ label: unc ? unc[1].replace(/^\\\\/, '') : root.replace(/\\$/, ''), path: root });
    let cur = root;
    for (const part of p.slice(root.length).split('\\').filter(Boolean)) {
      cur = joinPath(cur, part);
      out.push({ label: part, path: cur });
    }
    return out;
  }
  out.push({ label: '/', path: '/' });
  let cur = '/';
  for (const part of p.split('/').filter(Boolean)) {
    cur = joinPath(cur, part);
    out.push({ label: part, path: cur });
  }
  return out;
}

/** Why a name can't be a new folder's, or null when it can. */
export function folderNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Type a name for the folder.';
  if (/[\\/]/.test(n)) return "A folder name can't contain \\ or /.";
  if (n === '.' || n === '..') return "A folder can't be named . or ..";
  if (/[\u0000-\u001f<>:"|?*]/.test(n)) return 'A folder name can\'t contain any of these characters: < > : " | ? *';
  return null;
}

export const LAST_FOLDER_KEY = 'looper.lastFolder';

// ---------- the browser's history (Back and Forward) ----------

/** The folders visited, oldest first (null: the starting places), and the one shown. */
export interface NavHistory {
  stack: (string | null)[];
  at: number;
}

export const emptyHistory: NavHistory = { stack: [], at: -1 };

/** A folder opened (not by Back or Forward): it drops what Forward would go to. The one shown again changes nothing. */
export function navVisit(h: NavHistory, p: string | null): NavHistory {
  if (h.at >= 0 && h.stack[h.at] === p) return h;
  return { stack: [...h.stack.slice(0, h.at + 1), p], at: h.at + 1 };
}

/** The folder Back (-1) or Forward (1) goes to; undefined when there's none. */
export function navTarget(h: NavHistory, dir: -1 | 1): string | null | undefined {
  const i = h.at + dir;
  return i >= 0 && i < h.stack.length ? h.stack[i] : undefined;
}

export function navMove(h: NavHistory, dir: -1 | 1): NavHistory {
  return navTarget(h, dir) === undefined ? h : { ...h, at: h.at + dir };
}

// ---------- the starting places ----------

/** The heading a starting place is listed under. */
export function placeGroup(place: HostPlace | undefined): string {
  switch (place) {
    case 'drive':
      return 'Drives';
    case 'linux':
      return 'Linux';
    case 'project':
      return 'Projects';
    default:
      return 'Folders';
  }
}

/** The starting places with each group's heading before its first entry, in their order. */
export function groupPlaces(entries: HostDirEntry[]): { heading: string | null; entry: HostDirEntry }[] {
  let last: string | null = null;
  return entries.map((entry) => {
    const g = placeGroup(entry.place);
    const heading = g === last ? null : g;
    last = g;
    return { heading, entry };
  });
}

// ---------- the file viewer ----------

export type ViewerKind = 'image' | 'text' | 'markdown';

/** How a file opened on the device shows in the app itself; null: it doesn't (Open on Host Computer or Download). */
export function viewerKind(name: string): ViewerKind | null {
  const ext = extensionOf(name);
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'text';
  return null;
}

/** The largest file the viewer reads in, by kind. */
export const VIEWER_MAX_BYTES: Record<ViewerKind, number> = { image: 25 * 1024 * 1024, text: 5 * 1024 * 1024, markdown: 5 * 1024 * 1024 };

/** An <img>'s type for an image read as bytes (the download comes as application/octet-stream; an SVG needs its own). */
export function imageType(name: string): string {
  const ext = extensionOf(name);
  return ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
}
