import { useCallback, useRef, useState } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { isPhone } from '../../web/page-nav';
import { NavBar } from '../NavBar';
import { KEY_ROW, StickyCtrl, stepFontSize, type TermKey } from '../terminal-keys';

const ARROW_NAMES: Partial<Record<TermKey, string>> = { up: 'Up', down: 'Down', left: 'Left', right: 'Right' };
const FONT_KEY = 'terminal.phoneFontSize';
const DEFAULT_FONT = 11;

function savedFontSize(): number {
  const n = Number(localStorage.getItem(FONT_KEY));
  return Number.isFinite(n) && n >= 8 && n <= 24 ? n : DEFAULT_FONT;
}

export interface PhoneTerminal {
  /** Wire an opened xterm for a phone (font size, tap to type, no autocorrect); returns the cleanup. */
  attach(term: XTerm, el: HTMLElement, refit: () => void): () => void;
  /** What typed input sends: the sticky Ctrl applied once. */
  typed(data: string): string;
  /** The key row, on a phone; null elsewhere. */
  row: React.ReactNode;
}

/**
 * A terminal on a phone: a row of the keys its keyboard lacks (Esc, Tab, a
 * sticky Ctrl, arrows, | ~ / -) and font size steps, above the keyboard.
 * `send` writes to the terminal's session.
 */
export function usePhoneTerminal(send: (data: string) => void): PhoneTerminal {
  const ctrl = useRef(new StickyCtrl()).current;
  const [ctrlOn, setCtrlOn] = useState(false);
  const [fontSize, setFontSize] = useState(savedFontSize);
  const term = useRef<{ term: XTerm; refit: () => void } | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;

  const attach = useCallback((t: XTerm, el: HTMLElement, refit: () => void) => {
    term.current = { term: t, refit };
    if (!isPhone) return () => undefined;
    t.options.fontSize = savedFontSize();
    refit();
    // A tap on the terminal brings up the keyboard: xterm types through this hidden text box.
    const ta = t.textarea;
    if (ta) {
      ta.setAttribute('autocapitalize', 'off');
      ta.setAttribute('autocorrect', 'off');
      ta.setAttribute('autocomplete', 'off');
      ta.setAttribute('spellcheck', 'false');
    }
    const onTap = () => t.focus();
    el.addEventListener('click', onTap);
    return () => {
      el.removeEventListener('click', onTap);
      if (term.current?.term === t) term.current = null;
    };
  }, []);

  const typed = useCallback(
    (data: string) => {
      if (!ctrl.active) return data;
      const out = ctrl.typed(data);
      setCtrlOn(false);
      return out;
    },
    [ctrl],
  );

  const changeFont = (dir: 1 | -1) => {
    const next = stepFontSize(fontSize, dir);
    setFontSize(next);
    localStorage.setItem(FONT_KEY, String(next));
    const t = term.current;
    if (!t) return;
    t.term.options.fontSize = next;
    t.refit();
  };


  // Pressing a key mustn't take the focus from the terminal: the keyboard would go down.
  const keep = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

  const press = (k: TermKey) => {
    sendRef.current(ctrl.key(k, !!term.current?.term.modes.applicationCursorKeysMode));
    setCtrlOn(false);
  };
  const keyButton = ([k, label]: readonly [TermKey, string]) => (
    <button key={k} className="term-key" aria-label={ARROW_NAMES[k]} onClick={() => press(k)}>
      {label}
    </button>
  );

  const row = isPhone ? (
    <>
      {/* The text size isn't a key: it's in the window's More menu. */}
      <NavBar
        toolbar={[
          {
            id: 'terminal-text',
            items: [
              { id: 'terminal-text-smaller', label: 'Smaller Text', run: () => changeFont(-1), enabled: fontSize > stepFontSize(fontSize, -1) },
              { id: 'terminal-text-larger', label: 'Larger Text', run: () => changeFont(1), enabled: fontSize < stepFontSize(fontSize, 1) },
            ],
          },
        ]}
        order={5}
      />
      <div className="term-keys" role="toolbar" aria-label="Terminal keys" onPointerDown={keep} onMouseDown={keep}>
        <div className="term-keys-scroll">
          {KEY_ROW.slice(0, 2).map(keyButton)}
          <button className={`term-key${ctrlOn ? ' on' : ''}`} aria-pressed={ctrlOn} onClick={() => setCtrlOn(ctrl.toggle())}>
            Ctrl
          </button>
          {KEY_ROW.slice(2).map(keyButton)}
        </div>
      </div>
    </>
  ) : null;

  return { attach, typed, row };
}
