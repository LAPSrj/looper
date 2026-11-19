import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { EngineEvent } from '@shared/types';
import { subscribe } from '../events';
import { usePhoneTerminal } from './phone/TerminalKeys';
import { termTheme } from './term-theme';
import { reportError } from '../report-error';

/** An xterm in Looper's terminal style, opened in `el` and fitted to it. */
function openXterm(el: HTMLElement): { term: XTerm; fit: FitAddon } {
  const style = getComputedStyle(el);
  const term = new XTerm({
    fontFamily: 'Cascadia Mono, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: termTheme((token) => style.getPropertyValue(token)),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();
  return { term, fit };
}

/** The terminal whose right-click menu opened last in this window. */
let menuOwner: XTerm | null = null;

/** What a terminal shows and where its keys and size go. */
export interface TerminalIO {
  /** Writes the output so far to `term`; live output is written once it resolves. */
  replay(term: XTerm): Promise<void>;
  /** An engine event after the replay: writes what's this terminal's to `term`. */
  live(e: EngineEvent, term: XTerm): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Pasted or dropped files: copies them and returns their paths as the terminal pastes them. */
  attachFiles?(files: File[]): Promise<string>;
  /** The right-click menu (Copy, Paste, Attach Files…), whose choice comes back as a terminal-copy, terminal-paste or terminal-attached ui event. */
  showMenu?(hasSelection: boolean): void;
  /** Whether it takes the focus as it opens; unset: it does. */
  takesFocus?(): boolean;
}


/**
 * A terminal session's xterm, opened in `ref`'s element again whenever `key` changes: its output so far, then live,
 * with keys, files and size passed to it. `keys`: a phone's key row, to place under it (null elsewhere).
 */
export function useXterm(key: string, io: TerminalIO): { ref: RefObject<HTMLDivElement | null>; keys: ReactNode } {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(io);
  latest.current = io;
  const phone = usePhoneTerminal((d) => latest.current.write(d));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { term, fit } = openXterm(el);
    const refit = () => {
      try {
        fit.fit();
        latest.current.resize(term.cols, term.rows);
      } catch {
        /* element hidden */
      }
    };
    const detachPhone = phone.attach(term, el, refit);
    let loaded = false;
    void latest.current.replay(term).then(() => {
      loaded = true;
      latest.current.resize(term.cols, term.rows);
    });
    // The replay includes what came before it.
    const unsub = subscribe((e) => loaded && latest.current.live(e, term));
    const onData = term.onData((d) => latest.current.write(phone.typed(d)));
    // Copy and paste as Windows Terminal does: Ctrl+C with a selection (without one it stays the interrupt), Ctrl+Shift+C
    // and Ctrl+Insert copy; Ctrl+V, Ctrl+Shift+V and Shift+Insert paste. xterm would send Ctrl+V as ^V: the browser's own
    // paste runs instead, so a pasted image comes in as a file (the paste listener below) and text as xterm pastes it.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || e.altKey || e.metaKey) return true;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey && key === 'v') || (e.shiftKey && !e.ctrlKey && key === 'insert')) return false;
      if (!e.ctrlKey) return true;
      const copyKey = (key === 'c' && (e.shiftKey || term.hasSelection())) || (key === 'insert' && !e.shiftKey);
      if (!copyKey) return true;
      e.preventDefault();
      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(reportError);
        if (key === 'c' && !e.shiftKey) term.clearSelection();
      }
      return false;
    });
    const cleanups = [detachPhone, unsub, () => onData.dispose()];
    const listen = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, capture = false) => {
      el.addEventListener(type, fn, capture);
      cleanups.push(() => el.removeEventListener(type, fn, capture));
    };

    // Files go in as their paths, pasted the way a terminal pastes text: Claude
    // Code and Codex turn a pasted image path into an image attachment.
    const pastePaths = (text: string) => {
      if (!text) return;
      term.paste(text + ' ');
      term.focus();
    };
    const attachFiles = latest.current.attachFiles;
    if (attachFiles) {
      const attach = (files: File[]) => {
        if (files.length === 0) return;
        void attachFiles(files).then(pastePaths).catch(reportError);
      };
      // Capture phase: xterm handles text pastes itself, but drops a copied image without a word.
      listen(
        'paste',
        (e) => {
          const files = [...(e.clipboardData?.files ?? [])];
          if (files.length === 0 || e.clipboardData?.getData('text')) return;
          e.preventDefault();
          e.stopPropagation();
          attach(files);
        },
        true,
      );
      listen('dragover', (e) => {
        if (!e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
      });
      listen('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        attach([...(e.dataTransfer?.files ?? [])]);
      });
    }
    const showMenu = latest.current.showMenu;
    if (showMenu) {
      listen('contextmenu', (e) => {
        e.preventDefault();
        menuOwner = term;
        showMenu(term.hasSelection());
      });
      cleanups.push(
        window.looper.onUi((e) => {
          // The choice comes to the whole window: the terminal whose menu it was carries it out (a chat can show two commands' terminals).
          if (menuOwner !== term) return;
          if (e.type === 'terminal-copy') {
            void navigator.clipboard.writeText(term.getSelection());
          } else if (e.type === 'terminal-paste') {
            void navigator.clipboard.readText().then((t) => t && term.paste(t));
          } else if (e.type === 'terminal-attached') {
            pastePaths(e.text);
          }
        }),
      );
    }

    const ro = new ResizeObserver(refit);
    ro.observe(el);
    if (latest.current.takesFocus?.() ?? true) term.focus();
    return () => {
      for (const c of cleanups) c();
      ro.disconnect();
      if (menuOwner === term) menuOwner = null;
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { ref, keys: phone.row };
}
