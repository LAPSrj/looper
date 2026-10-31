import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { termTheme } from './term-theme';

/** An xterm in Looper's terminal style, opened in `el` and fitted to it. */
export function openXterm(el: HTMLElement): { term: XTerm; fit: FitAddon } {
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
