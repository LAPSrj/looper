// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import type { DialogResult, FileDialogSpec, FileFilterSpec, HostDirEntry, MessageBoxSpec } from '../../../shared/remote-access';

// ---------- message boxes ----------

export const messageResult = (response: number, checkboxChecked: boolean): DialogResult => ({ kind: 'message', response, checkboxChecked });

/** Esc or the window's ×: the cancel button (Electron's default is the last one). */
export const messageCancelId = (spec: MessageBoxSpec): number => spec.cancelId ?? Math.max(0, spec.buttons.length - 1);

/** The button that has the focus first. */
export const messageDefaultId = (spec: MessageBoxSpec): number =>
  spec.defaultId !== undefined && spec.defaultId >= 0 && spec.defaultId < spec.buttons.length ? spec.defaultId : 0;

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
  /** null: the starting places ("This Computer"). */
  path: string | null;
}

/** The path as clickable parts, after "This Computer". */
export function breadcrumbs(p: string | null): Crumb[] {
  const out: Crumb[] = [{ label: 'This Computer', path: null }];
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
