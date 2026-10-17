import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

/** An xterm in Looper's terminal style, opened in `el` and fitted to it. */
export function openXterm(el: HTMLElement): { term: XTerm; fit: FitAddon } {
  const term = new XTerm({
    fontFamily: 'Cascadia Mono, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    theme: { background: '#0f1115', foreground: '#d7dae0', cursor: '#d7dae0', selectionBackground: '#3a4252' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();
  return { term, fit };
}
