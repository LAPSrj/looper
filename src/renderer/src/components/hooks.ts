import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { SettingsSchema, type Settings } from '@shared/types';
import { subscribe } from '../events';
import { enterPressesDefault, listNavKey, type ListNavModel } from './list-nav';

/** Settings → Chats, shared by every row of a conversation in the window: read once, then kept current. */
let chatsSettings: Settings['chats'] = SettingsSchema.shape.chats.parse(undefined);
let chatsListening = false;
const chatsListeners = new Set<() => void>();
function setChatsSettings(next: Settings['chats']): void {
  if (JSON.stringify(next) === JSON.stringify(chatsSettings)) return;
  chatsSettings = next;
  for (const l of chatsListeners) l();
}
function watchChatsSettings(onChange: () => void): () => void {
  if (!chatsListening) {
    chatsListening = true;
    void window.looper.info().then((i) => setChatsSettings(i.settings.chats));
    subscribe((e) => {
      if (e.type === 'settings') setChatsSettings(e.settings.chats);
    });
  }
  chatsListeners.add(onChange);
  return () => chatsListeners.delete(onChange);
}
export function useChatsSettings(): Settings['chats'] {
  return useSyncExternalStore(watchChatsSettings, () => chatsSettings);
}

/** Whether the project's folder is in a git repository; it's checked again whenever the project changes. */
export function useGitRepo(projectId: string | undefined): boolean {
  const [repos, setRepos] = useState<string[]>([]);
  useEffect(() => {
    void window.looper.git.repos().then(setRepos);
    return subscribe((e) => {
      if (e.type === 'git-repos') setRepos(e.ids);
    });
  }, []);
  useEffect(() => {
    if (projectId) void window.looper.git.check(projectId);
  }, [projectId]);
  return !!projectId && repos.includes(projectId);
}

/**
 * Create-on-add: a new entry already exists in the settings so its editor
 * window could open; closing the window without Create removes it again
 * (`discard`). Set the returned ref once the entry is saved.
 */
export function useDiscardUnsaved(isNew: boolean | undefined, discard: () => void): RefObject<boolean> {
  const savedRef = useRef(false);
  const discardRef = useRef(discard);
  discardRef.current = discard;
  useEffect(() => {
    if (!isNew) return;
    const onUnload = () => {
      if (!savedRef.current) discardRef.current();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [isNew]);
  return savedRef;
}

/** The settings and host kind, kept current; `missing` once the entry the window edits (`found`) is gone from them. */
export function useLiveSettings(found: (s: Settings) => boolean): { live: Settings | null; host: string | undefined; missing: boolean } {
  const [live, setLive] = useState<Settings | null>(null);
  const [host, setHost] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  const foundRef = useRef(found);
  foundRef.current = found;
  useEffect(() => {
    void window.looper.info().then((info) => {
      setLive(info.settings);
      setHost(info.host);
      if (!foundRef.current(info.settings)) setMissing(true);
    });
    return subscribe((e) => {
      if (e.type !== 'settings') return;
      setLive(e.settings);
      if (!foundRef.current(e.settings)) setMissing(true);
    });
  }, []);
  return { live, host, missing };
}

interface DialogKeysOpts<T extends string> {
  onSave?: () => void | Promise<void>;
  onCancel?: () => void;
  /** Fire onSave on a plain Enter anywhere, not just Ctrl+Enter / Enter on an input. */
  enterAnywhere?: boolean;
  tabs?: readonly T[];
  tab?: T;
  onTab?: (id: T) => void;
}

/**
 * Dialog keyboard semantics: Esc = cancel, Enter on a single-line input or
 * Ctrl+Enter anywhere = save, Ctrl+Tab / Ctrl+PageDown|PageUp = cycle tabs.
 * Handlers are read fresh on every keystroke, so callers can pass plain closures.
 */
export function useDialogKeys<T extends string = string>(opts: DialogKeysOpts<T>): void {
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const o = ref.current;
      if (e.key === 'Escape' && o.onCancel) {
        e.preventDefault();
        o.onCancel();
        return;
      }
      if (e.key === 'Enter' && o.onSave && (o.enterAnywhere || e.ctrlKey || enterPressesDefault(e.target)) && !e.isComposing && !e.defaultPrevented) {
        e.preventDefault();
        void o.onSave();
        return;
      }
      if (!o.tabs || o.tab === undefined || !o.onTab) return;
      const order = o.tabs;
      const cycle = (dir: number) => o.onTab!(order[(order.indexOf(o.tab!) + dir + order.length) % order.length]);
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (e.ctrlKey && e.key === 'PageDown') {
        e.preventDefault();
        cycle(1);
      } else if (e.ctrlKey && e.key === 'PageUp') {
        e.preventDefault();
        cycle(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

interface ListNavOpts extends ListNavModel {
  /** DOM id of the active row; scrolled into view when it changes. */
  scrollToId?: string | null;
}

/**
 * A list's keyboard: Up, Down, Home, End; Enter (onActivate), Delete (onDelete),
 * F2 (onRename); Shift+F10 and the Menu key (onMenu); in a tree, Left and Right
 * close and open a row (or step to its parent or first child) and Space toggles.
 * The model is in list-nav.ts. Returns the list's `onKeyDown`.
 */
export function useListNav({ scrollToId, ...model }: ListNavOpts): (e: ReactKeyboardEvent) => void {
  useEffect(() => {
    if (!scrollToId) return;
    document.getElementById(scrollToId)?.scrollIntoView({ block: 'nearest' });
  }, [scrollToId]);
  return (e: ReactKeyboardEvent) => {
    // A text box or drop-down inside the list keeps its own editing keys, and a button its Space.
    const t = e.target as HTMLElement;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable;
    if (typing && !['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) return;
    if (t.tagName === 'BUTTON' && e.key === ' ') return;
    listNavKey(e, model);
  };
}

interface DragResizeOpts {
  axis: 'x' | 'y';
  containerRef: RefObject<HTMLElement | null>;
  /** Pointer position relative to the container's left/top edge, on every move. */
  onDrag: (pos: number, rect: DOMRect) => void;
  /** The mouse was released. */
  onEnd?: () => void;
}

/** Mouse-drag handler for a splitter; returns the divider's onMouseDown. */
export function useDragResize({ axis, containerRef, onDrag, onEnd }: DragResizeOpts): (e: ReactMouseEvent) => void {
  const dragging = useRef(false);
  const onDragRef = useRef(onDrag);
  onDragRef.current = onDrag;
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  return useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
      const onMove = (me: MouseEvent) => {
        if (!dragging.current || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        onDragRef.current(axis === 'x' ? me.clientX - rect.left : me.clientY - rect.top, rect);
      };
      const onUp = () => {
        dragging.current = false;
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        onEndRef.current?.();
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [axis, containerRef],
  );
}

/** Which kind of window this is, so a box's height is remembered for each: a single chat's window, the Chats window, any other. */
function windowKind(): string {
  const route = location.hash.replace(/^#\/?/, '');
  return /^sessions\/[^/]+\/window$/.test(route) ? 'chat' : route.startsWith('sessions') ? 'chats' : 'main';
}

/**
 * A desktop message box made taller by dragging its top border: its own height
 * (the Send and Stop buttons') is the least, and the most is half of what holds
 * the composer. `rootRef`: the composer; the height is saved for the window's kind.
 * Returns the box's `minHeight` and the border's `onMouseDown`.
 */
export function useBoxHeight(rootRef: RefObject<HTMLElement | null>): { minHeight: string | undefined; onGrip: (e: ReactMouseEvent) => void } {
  const key = `composer.height.${windowKind()}`;
  const [height, setHeight] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem(key));
    return saved > 0 ? saved : null;
  });
  const latest = useRef(height);
  latest.current = height;
  const onGrip = useDragResize({
    axis: 'y',
    containerRef: rootRef,
    onDrag: (pos, rect) => {
      const root = rootRef.current;
      if (!root) return;
      const least = root.querySelector<HTMLElement>('.composer-actions')?.offsetHeight ?? 0;
      const most = Math.max(least, (root.parentElement?.clientHeight ?? 0) / 2);
      const wanted = rect.height - pos - (parseFloat(getComputedStyle(root).paddingBottom) || 0);
      const next = Math.min(most, wanted);
      latest.current = next <= least ? null : Math.round(next);
      setHeight(latest.current);
    },
    onEnd: () => {
      if (latest.current === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(latest.current));
    },
  });
  // A height saved in a taller window still fits a smaller one.
  return { minHeight: height === null ? undefined : `min(${height}px, 50vh)`, onGrip };
}
