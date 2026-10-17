import { useEffect, useRef } from 'react';
import { subscribe } from './events';
import { openXterm } from './components/xterm';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const ENDED = `\r\n${DIM}── session ended ──${RESET}\r\n`;

const reportError = (e: Error) => void window.looper.showError(e.message);

/** A Looper terminal window: one terminal session (Open Project in Terminal, Continue in Terminal). */
export function TerminalSessionApp({ id, title }: { id: string; title: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { term, fit } = openXterm(el);
    let loaded = false;
    void window.looper.terminalSession.output(id).then((out) => {
      if (out?.data) term.write(out.data);
      if (!out || out.ended) term.write(ENDED);
      loaded = true;
      window.looper.terminalSession.resize(id, term.cols, term.rows);
    });
    const unsub = subscribe((e) => {
      if (!loaded) return; // the replay above includes it
      if (e.type === 'terminal:data' && e.id === id) term.write(e.data);
      else if (e.type === 'terminal:end' && e.id === id) term.write(ENDED);
    });
    const onData = term.onData((d) => window.looper.terminalSession.write(id, d));

    // Files go in as their paths, pasted the way a terminal pastes text: Claude
    // Code and Codex turn a pasted image path into an image attachment.
    const pastePaths = (text: string) => {
      if (!text) return;
      term.paste(text + ' ');
      term.focus();
    };
    const attach = (files: File[]) => {
      if (files.length === 0) return;
      void window.looper.terminalSession.attachFiles(id, files).then(pastePaths).catch(reportError);
    };
    // Capture phase: xterm handles text pastes itself, but drops a copied image without a word.
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0 || e.clipboardData?.getData('text')) return;
      e.preventDefault();
      e.stopPropagation();
      attach(files);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      attach([...(e.dataTransfer?.files ?? [])]);
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      window.looper.terminalSession.showContextMenu(id, term.hasSelection());
    };
    el.addEventListener('paste', onPaste, true);
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    el.addEventListener('contextmenu', onContextMenu);
    const unsubUi = window.looper.onUi((e) => {
      if (e.type === 'terminal-copy') {
        void navigator.clipboard.writeText(term.getSelection());
      } else if (e.type === 'terminal-paste') {
        void navigator.clipboard.readText().then((t) => t && term.paste(t));
      } else if (e.type === 'terminal-attached') {
        pastePaths(e.text);
      }
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        window.looper.terminalSession.resize(id, term.cols, term.rows);
      } catch {
        /* element hidden */
      }
    });
    ro.observe(el);
    term.focus();
    return () => {
      unsub();
      unsubUi();
      onData.dispose();
      el.removeEventListener('paste', onPaste, true);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
      el.removeEventListener('contextmenu', onContextMenu);
      ro.disconnect();
      term.dispose();
    };
  }, [id]);
  return (
    <div className="terminal-session">
      <div className="terminal" ref={ref} />
    </div>
  );
}
