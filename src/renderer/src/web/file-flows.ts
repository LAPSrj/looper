import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { attachmentName } from '../../../shared/chat';
import { baseName } from '../../../shared/paths';
import { REMOTE_CHANNELS, type HostDirEntry, type HostDirListing, type MessageBoxSpec } from '../../../shared/remote-access';
import { languageOf } from '../components/code-languages';
import type { ShellController } from './controller';
import {
  allowedExtensions,
  breadcrumbs,
  emptyHistory,
  fileSources,
  folderNameError,
  imageType,
  initialSource,
  joinPath,
  LAST_FOLDER_KEY,
  navMove,
  navTarget,
  navVisit,
  openCanceled,
  openResult,
  picksFolders,
  picksMany,
  saveCanceled,
  saveToComputer,
  saveToDevice,
  sourceKey,
  splitDefaultPath,
  viewerKind,
  VIEWER_MAX_BYTES,
  HOST_COMPUTER,
  visibleEntries,
  withExtension,
  type FileSource,
  type NavHistory,
  type ViewerKind,
} from './dialog-flows';
import type { OpenDialog, PathRequest } from './store';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A message box the shell asks itself (an error, Replace?), drawn like the computer's. */
export interface LocalMessage {
  spec: MessageBoxSpec;
  onAnswer: (response: number) => void;
}

export function useLocalMessage():[LocalMessage | null, (spec: MessageBoxSpec) => Promise<number>] {
  const [msg, setMsg] = useState<LocalMessage | null>(null);
  const ask = useCallback(
    (spec: MessageBoxSpec) =>
      new Promise<number>((resolve) =>
        setMsg({
          spec,
          onAnswer: (r) => {
            setMsg(null);
            resolve(r);
          },
        }),
      ),
    [],
  );
  return [msg, ask];
}

const storage = {
  get: (k: string): string | null => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string): void => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

// ---------- the computer's folders ----------

export interface HostBrowserOptions {
  /** The window the calls are made for. */
  w: string;
  /** The folder to open first; null = the starting places. */
  start: string | null;
  /** Whether files are listed (folders always are). */
  files: boolean;
  extensions: string[] | null;
  multi: boolean;
  /** Nothing to browse (show-path of a file): no listing is asked for. */
  skip?: boolean;
  /** A folder the user opened couldn't be read; the browser stays where it was. */
  onError: (err: unknown) => void;
}

export interface HostBrowser {
  /** null: the starting places. */
  path: string | null;
  parent: string | null;
  entries: HostDirEntry[];
  crumbs: ReturnType<typeof breadcrumbs>;
  loading: boolean;
  selected: string[];
  select: (entry: HostDirEntry, opts?: { toggle?: boolean }) => void;
  /** These entries selected (only the last one when the browser picks one). */
  setSelection: (paths: string[]) => void;
  clearSelection: () => void;
  go: (path: string | null) => void;
  up: () => void;
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
  /** The host user's home folder, or null when it isn't known yet (or can't be reached). */
  home: string | null;
  refresh: () => void;
  /** Make a folder in the current one and select it; resolves its path, or null (onError has heard why). */
  makeDir: (name: string) => Promise<string | null>;
}

/** The host file browser over remote:listDir: the folder shown, its entries and the selection. */
export function useHostBrowser(controller: ShellController, o: HostBrowserOptions): HostBrowser {
  const [listing, setListing] = useState<HostDirListing | null>(null);
  const [loading, setLoading] = useState(!o.skip);
  const [selected, setSelected] = useState<string[]>([]);
  const [history, setHistory] = useState<NavHistory>(emptyHistory);
  const seq = useRef(0);
  const onError = useRef(o.onError);
  onError.current = o.onError;

  /**
   * first: the folder to start in; when it's gone, the starting places, without a word.
   * nav: how the history takes it: a visit (the default), Back or Forward, or not at all (a refresh).
   */
  const load = useCallback(
    (p: string | null, opts: { select?: string; first?: boolean; nav?: 'visit' | -1 | 1 | 'stay' } = {}) => {
      const n = ++seq.current;
      setLoading(true);
      controller
        .invoke<HostDirListing>(o.w, REMOTE_CHANNELS.listDir, p)
        .then((l) => {
          if (n !== seq.current) return;
          setListing(l);
          setSelected(opts.select ? [opts.select] : []);
          setLoading(false);
          const nav = opts.nav ?? 'visit';
          if (nav === 'visit') setHistory((h) => navVisit(h, l.path));
          else if (nav !== 'stay') setHistory((h) => navMove(h, nav));
        })
        .catch((err) => {
          if (n !== seq.current) return;
          setLoading(false);
          if (opts.first && p !== null) load(null);
          else onError.current(err);
        });
    },
    [controller, o.w],
  );

  useEffect(() => {
    if (!o.skip) load(o.start, { first: true });
  }, [load, o.start, o.skip]);

  const entries = useMemo(
    () => (listing ? visibleEntries(listing.entries, { files: o.files, extensions: o.extensions }) : []),
    [listing, o.files, o.extensions],
  );
  const path = listing?.path ?? null;

  return {
    path,
    parent: listing?.parent ?? null,
    entries,
    crumbs: breadcrumbs(path),
    loading,
    selected,
    select: (entry, opts) =>
      setSelected((cur) => (o.multi && opts?.toggle ? (cur.includes(entry.path) ? cur.filter((p) => p !== entry.path) : [...cur, entry.path]) : [entry.path])),
    setSelection: (paths) => setSelected(o.multi ? paths : paths.slice(-1)),
    clearSelection: () => setSelected([]),
    go: (p) => load(p),
    up: () => {
      if (path !== null) load(listing?.parent ?? null);
    },
    canBack: navTarget(history, -1) !== undefined,
    canForward: navTarget(history, 1) !== undefined,
    back: () => {
      const to = navTarget(history, -1);
      if (to !== undefined) load(to, { nav: -1 });
    },
    forward: () => {
      const to = navTarget(history, 1);
      if (to !== undefined) load(to, { nav: 1 });
    },
    home: listing?.home ?? null,
    refresh: () => load(path, { nav: 'stay' }),
    makeDir: async (name) => {
      try {
        const why = folderNameError(name);
        if (why) throw new Error(why);
        if (path === null) throw new Error('Open a folder first.');
        const made = await controller.invoke<string>(o.w, REMOTE_CHANNELS.makeDir, path, name.trim());
        load(path, { select: made, nav: 'stay' });
        return made;
      } catch (err) {
        onError.current(err);
        return null;
      }
    },
  };
}

// ---------- open and save dialogs ----------

export interface FileDialogFlow {
  kind: 'open' | 'save';
  title: string;
  sources: FileSource[];
  source: FileSource;
  setSource: (s: FileSource) => void;
  browser: HostBrowser;
  folders: boolean;
  multi: boolean;
  /** Save: the file name being typed. */
  name: string;
  setName: (n: string) => void;
  /** <input type=file> accept and multiple, for This Device. */
  extensions: string[] | null;
  /** What's going on (uploading), or ''. */
  busy: string;
  message: LocalMessage | null;
  /** The primary button: Open / Select Folder / Save. */
  confirmLabel: string;
  canConfirm: boolean;
  confirm: () => void;
  /** Double-click or Enter on an entry. */
  activate: (entry: HostDirEntry) => void;
  /** Files the user chose on this device: they go to the computer and the dialog answers with their paths there. */
  fromDevice: (files: File[]) => void;
  cancel: () => void;
}

/** The flow of a computer's open or save dialog: Host Computer's browser or This Device, and the answer's shape. */
export function useFileDialog(controller: ShellController, dialog: Extract<OpenDialog, { kind: 'open' | 'save' }>): FileDialogFlow {
  const { kind, spec } = dialog;
  const folders = kind === 'open' && picksFolders(spec);
  const multi = kind === 'open' && picksMany(spec);
  const sources = fileSources(kind, spec);
  const [source, setSourceState] = useState<FileSource>(() => initialSource(kind, spec, storage.get(sourceKey(kind))));
  const split = useMemo(() => splitDefaultPath(spec.defaultPath), [spec.defaultPath]);
  const start = split.dir ?? storage.get(LAST_FOLDER_KEY);
  const extensions = useMemo(() => allowedExtensions(spec.filters), [spec.filters]);
  const [message, ask] = useLocalMessage();
  const fail = (err: unknown) => void ask({ type: 'error', title: spec.title ?? 'Looper', message: errorText(err), buttons: ['OK'], defaultId: 0, cancelId: 0 });
  const browser = useHostBrowser(controller, {
    w: dialog.w,
    start,
    files: !folders || !!spec.properties?.includes('openFile'),
    extensions,
    multi,
    onError: fail,
  });
  const [name, setName] = useState(split.name);
  const [busy, setBusy] = useState('');
  const answered = useRef(false);

  const answer = (result: Parameters<ShellController['answer']>[1], used?: FileSource) => {
    if (answered.current) return;
    answered.current = true;
    if (used) storage.set(sourceKey(kind), used);
    if (used === 'computer' && browser.path) storage.set(LAST_FOLDER_KEY, browser.path);
    controller.answer(dialog.dialogId, result);
  };

  const selectedEntries = browser.entries.filter((e) => browser.selected.includes(e.path));
  const typed = name.trim();
  const canConfirm =
    !busy &&
    (source === 'device'
      ? kind === 'save' && !!typed
      : kind === 'save'
        ? !!typed && browser.path !== null
        : folders
          ? selectedEntries.some((e) => e.dir) || browser.path !== null
          : selectedEntries.some((e) => !e.dir));

  const saveHere = async () => {
    const file = withExtension(typed, spec.filters);
    const dir = browser.path;
    if (!dir) return;
    if (/[\\/]/.test(file)) return fail(new Error("A file name can't contain \\ or /."));
    const existing = browser.entries.find((e) => e.name.toLowerCase() === file.toLowerCase());
    if (existing?.dir) return fail(new Error(`${file} is a folder.`));
    if (existing) {
      const r = await ask({
        type: 'warning',
        title: 'Confirm Save As',
        message: `${file} already exists.`,
        detail: 'Do you want to replace it?',
        buttons: ['Yes', 'No'],
        defaultId: 1,
        cancelId: 1,
        destructiveId: 0,
      });
      if (r !== 0) return;
    }
    answer(saveToComputer(joinPath(dir, file)), 'computer');
  };

  const confirm = () => {
    if (!canConfirm) return;
    if (source === 'device') return answer(saveToDevice(withExtension(typed, spec.filters)), 'device');
    if (kind === 'save') return void saveHere();
    if (folders) {
      const dir = selectedEntries.find((e) => e.dir)?.path ?? browser.path;
      if (dir) answer(openResult([dir]), 'computer');
      return;
    }
    answer(openResult(selectedEntries.filter((e) => !e.dir).map((e) => e.path)), 'computer');
  };

  return {
    kind,
    title: spec.title ?? (kind === 'save' ? 'Save As' : folders ? 'Select Folder' : 'Open'),
    sources,
    source,
    setSource: (s) => {
      setSourceState(s);
      storage.set(sourceKey(kind), s);
    },
    browser,
    folders,
    multi,
    name,
    setName,
    extensions,
    busy,
    message,
    confirmLabel: spec.buttonLabel ?? (kind === 'save' ? 'Save' : folders ? 'Select Folder' : 'Open'),
    canConfirm,
    confirm,
    activate: (entry) => {
      if (entry.dir) return browser.go(entry.path);
      if (kind === 'save') {
        setName(entry.name);
        return;
      }
      if (!folders) answer(openResult([entry.path]), 'computer');
    },
    fromDevice: (files) => {
      if (files.length === 0) return;
      void (async () => {
        const paths: string[] = [];
        try {
          for (const f of files) {
            setBusy(`Sending ${f.name || 'file'} to the host computer…`);
            paths.push((await controller.upload(f)).path);
          }
        } catch (err) {
          setBusy('');
          fail(err);
          return;
        }
        setBusy('');
        answer(openResult(paths), 'device');
      })();
    },
    cancel: () => answer(kind === 'open' ? openCanceled : saveCanceled),
  };
}

// ---------- show-path ----------

/** A file shown in the app (a chat attachment clicked), with Download to This Device and to Host Computer. */
export interface FileView {
  kind: ViewerKind;
  /** An image's data: URL; null while it loads or when it can't be shown. */
  url: string | null;
  /** A text, code or Markdown file's text; null while it loads or when it can't be shown. */
  text: string | null;
  /** A PDF's bytes; null while it loads or when it can't be shown. */
  pdf: ArrayBuffer | null;
  /** Why it can't be shown, or ''. */
  error: string;
  toDevice: () => void;
  toHost: () => void;
  /** A phone's one Download button: asks where, naming this device. */
  askDownload: (thisDevice: string) => void;
}

export interface PathFlow {
  req: PathRequest;
  name: string;
  browser: HostBrowser | null;
  /** A file the app shows itself; null: a folder, or a file asked about (Open on Host Computer, Download). */
  view: FileView | null;
  message: LocalMessage | null;
  /** A message's several images: Previous and Next, and the images either side for a swipe. */
  steps: { index: number; count: number; go: (index: number) => void; src: (step: -1 | 1) => string | null } | null;
  /** The selected file, or the request's file. */
  canDownload: boolean;
  download: () => void;
  openOnComputer: () => void;
  activate: (entry: HostDirEntry) => void;
  /** A file tapped on a phone: the viewer over the folder, or Open on Host Computer | Download. */
  openFile: (entry: HostDirEntry) => void;
  close: () => void;
}


function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("The image couldn't be read."));
    r.readAsDataURL(blob);
  });
}

interface Shown {
  url: string | null;
  text: string | null;
  pdf: ArrayBuffer | null;
  error: string;
}

const LOADING: Shown = { url: null, text: null, pdf: null, error: '' };

const isCodeFile = (name: string): boolean => languageOf(name) !== undefined;

/** A file on the computer read in for the viewer, in the form its kind is shown in. */
async function readShown(controller: ShellController, path: string, kind: ViewerKind): Promise<Shown> {
  const name = attachmentName(path);
  try {
    const blob = await controller.readHostFile(path, VIEWER_MAX_BYTES[kind]);
    if (!blob) return { ...LOADING, error: `${name} is too big to show here.` };
    if (kind === 'image') return { ...LOADING, url: await dataUrl(new Blob([blob], { type: imageType(path) })) };
    if (kind === 'pdf') return { ...LOADING, pdf: await blob.arrayBuffer() };
    return { ...LOADING, text: await blob.text() };
  } catch (err) {
    return { ...LOADING, error: errorText(err) };
  }
}

/** A path the computer showed this device: a folder to browse (download or open what's in it), or a file to open or download. */
export function usePathRequest(controller: ShellController, req: PathRequest): PathFlow {
  const [w] = useState(() => controller.anyWindow() ?? '');
  const [message, ask] = useLocalMessage();
  const fail = (err: unknown) => void ask({ type: 'error', title: 'Looper', message: errorText(err), buttons: ['OK'], defaultId: 0, cancelId: 0 });
  const browser = useHostBrowser(controller, { w, start: req.path, files: true, extensions: null, multi: false, skip: !req.isDir, onError: fail });
  const close = () => controller.closePath(req.id);
  const file = req.isDir ? browser.entries.find((e) => !e.dir && browser.selected.includes(e.path)) : undefined;
  const siblings = req.siblings && req.siblings.length > 1 ? req.siblings : null;
  const [index, setIndex] = useState(() => Math.max(0, siblings?.indexOf(req.path) ?? 0));
  const current = siblings ? siblings[index] : req.path;
  // A file by its own name: an attachment copy's without the stamp in front.
  const name = req.isDir ? baseName(current) : attachmentName(current);
  const kind = req.isDir ? null : viewerKind(name, isCodeFile);
  // Files read in, by path: the shown one and its neighbors, which a swipe draws beside it and shows at once.
  const read = useRef(new Map<string, Promise<Shown>>());
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Shown>>(() => new Map());
  const shown = loaded.get(current) ?? LOADING;

  // A file the viewer shows: read in and kept. An image as a data: URL, which the page's Content-Security-Policy allows (blob: it doesn't).
  useEffect(() => {
    if (!kind) return;
    let live = true;
    const load = (path: string): Promise<Shown> => {
      let p = read.current.get(path);
      if (!p) {
        p = readShown(controller, path, viewerKind(attachmentName(path), isCodeFile) ?? 'text');
        read.current.set(path, p);
      }
      return p;
    };
    const near = siblings ? [siblings[index - 1], current, siblings[index + 1]].filter((p): p is string => !!p) : [current];
    for (const path of read.current.keys()) if (!near.includes(path)) read.current.delete(path);
    setLoaded((m) => ([...m.keys()].every((p) => near.includes(p)) ? m : new Map([...m].filter(([p]) => near.includes(p)))));
    for (const path of near)
      void load(path).then((s) => {
        if (live) setLoaded((m) => (m.get(path) === s ? m : new Map(m).set(path, s)));
      });
    return () => {
      live = false;
    };
    // `siblings` comes with the request and doesn't change.
  }, [controller, current, kind]);

  // Any other file: Open on Host Computer | Download | Cancel.
  useEffect(() => {
    if (req.isDir || kind) return;
    void ask({
      type: 'question',
      title: 'Looper',
      message: name,
      detail: req.path,
      buttons: ['Open on Host Computer', 'Download', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    }).then(async (r) => {
      try {
        if (r === 0) await controller.openOnHost(req.path);
        else if (r === 1) await controller.downloadHostFile(req.path);
      } catch (err) {
        await ask({ type: 'error', title: 'Looper', message: errorText(err), buttons: ['OK'], defaultId: 0, cancelId: 0 });
      }
      controller.closePath(req.id);
    });
    // Asked once, when the request arrives.
  }, []);

  const toDevice = () => void controller.downloadHostFile(current).catch(fail);
  const toHost = () =>
    void controller
      .saveOnHost(current)
      .then((saved) => ask({ type: 'info', title: 'Looper', message: `Downloaded ${baseName(saved)} to the host computer.`, detail: saved, buttons: ['OK'], defaultId: 0, cancelId: 0 }))
      .catch(fail);
  return {
    req,
    name,
    browser: req.isDir ? browser : null,
    view: kind
      ? {
          kind,
          ...shown,
          toDevice,
          toHost,
          askDownload: (thisDevice) =>
            void ask({ type: 'question', title: 'Looper', message: name, buttons: [`Download to ${thisDevice}`, `Download to ${HOST_COMPUTER}`, 'Cancel'], defaultId: 0, cancelId: 2 }).then((r) => {
              if (r === 0) toDevice();
              else if (r === 1) toHost();
            }),
        }
      : null,
    message,
    steps: siblings
      ? {
          index,
          count: siblings.length,
          go: (to) => setIndex(Math.max(0, Math.min(siblings.length - 1, to))),
          src: (step) => {
            const path = siblings[index + step];
            return path ? (loaded.get(path)?.url ?? null) : null;
          },
        }
      : null,
    openFile: (entry) => controller.showPath(entry.path),
    canDownload: !!file,
    download: () => {
      if (file) void controller.downloadHostFile(file.path).catch(fail);
    },
    openOnComputer: () => {
      const target = browser.selected[0] ?? browser.path;
      if (target) void controller.openOnHost(target).catch(fail);
    },
    activate: (entry) => {
      if (entry.dir) browser.go(entry.path);
      else void controller.downloadHostFile(entry.path).catch(fail);
    },
    close,
  };
}
