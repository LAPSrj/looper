import { useEffect } from 'react';
import { assignAccessKeys, NO_ACCESS_KEY } from './access-key-assign';

/** A control that has an access key: what shows its letter, what the key does, and the text the key is chosen from. */
interface Target {
  /** Where the letter is underlined. */
  label: HTMLElement;
  text: string;
  run: () => void;
}

const HIGHLIGHT = 'access-keys';

const shown = (el: Element): boolean => el.getClientRects().length > 0 && !el.closest('[inert], [hidden], [aria-hidden="true"]');
const textOf = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * Focus a control, or press it when it's a check box, a radio button, a button or a tab (as Win32's access keys do).
 * `focusOnly`: the key is a group's label, so it reaches the group's first control without pressing it.
 */
function activate(control: HTMLElement | null | undefined, focusOnly = false): void {
  if (!control || (control as HTMLInputElement).disabled) return;
  control.focus();
  if (focusOnly) return;
  const type = (control as HTMLInputElement).type;
  if (control.matches('button, [role=tab]') || type === 'checkbox' || type === 'radio') control.click();
}

/** The controls of the window that take access keys, the commit buttons first, then the rest in the page's order. */
function targets(): Target[] {
  const commit: Target[] = [];
  const rest: Target[] = [];
  for (const b of document.querySelectorAll<HTMLButtonElement>('.footer-commit button, .footer-extras button')) {
    const text = textOf(b);
    if (shown(b) && text && !NO_ACCESS_KEY.has(text)) commit.push({ label: b, text, run: () => activate(b) });
  }
  const content = document.querySelectorAll<HTMLElement>('.field-label, label.checkbox-field, [role=tab], button.btn');
  for (const el of content) {
    if (!shown(el) || el.closest('.editor-footer')) continue;
    const text = textOf(el);
    if (!text || NO_ACCESS_KEY.has(text)) continue;
    if (el instanceof HTMLLabelElement && el.classList.contains('field-label')) {
      const control = el.control;
      const first = el.closest('.field')?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea, button, [tabindex="0"]');
      if (control) rest.push({ label: el, text, run: () => activate(control) });
      else if (first) rest.push({ label: el, text, run: () => activate(first, true) });
    } else if (el instanceof HTMLLabelElement) {
      rest.push({ label: el, text, run: () => activate(el.querySelector('input')) });
    } else if (el.classList.contains('field-label')) {
      // A label that isn't a <label> names a group (check boxes, a list): its first control.
      const first = el.closest('.field, .radio-field')?.querySelector<HTMLElement>('input, select, textarea, button, [tabindex="0"]');
      if (first) rest.push({ label: el, text, run: () => activate(first, true) });
    } else {
      rest.push({ label: el, text, run: () => activate(el) });
    }
  }
  return [...commit, ...rest];
}

/** A range over the `index`th character of an element's text, for the underline. */
function rangeAt(el: HTMLElement, index: number): Range | null {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let seen = 0;
  // The label's text as textOf gives it: leading space and runs of white space count once.
  const flat = (el.textContent ?? '').replace(/\s+/g, ' ');
  const lead = flat.length - flat.trimStart().length;
  let want = index + lead;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = (n.nodeValue ?? '').replace(/\s+/g, ' ');
    if (want < seen + t.length) {
      const range = document.createRange();
      range.setStart(n, want - seen);
      range.setEnd(n, want - seen + 1);
      return range;
    }
    seen += t.length;
  }
  return null;
}

/**
 * Access keys for a dialog or editor on the desktop: while Alt is held each control's letter is underlined (as the
 * menu bar's are), and Alt+letter focuses that control, or presses it when it's a check box, a radio button, a button
 * or a tab. Keys are given out when Alt goes down, unique in the window (`assignAccessKeys`); OK, Cancel and Close have
 * none (Enter and Esc). A window that draws a menu bar leaves Alt to it.
 */
export function useAccessKeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const registry = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
    let keyed: { target: Target; key: string }[] = [];
    const compute = () => {
      const list = targets();
      const keys = assignAccessKeys(list.map((t) => t.text));
      keyed = list.map((target, i) => ({ target, key: keys[i].key, index: keys[i].index })).filter((k) => k.key);
      return list.map((target, i) => ({ target, ...keys[i] })).filter((k) => k.key);
    };
    const show = () => {
      const all = compute();
      if (!registry) return;
      const ranges = all.map((k) => rangeAt(k.target.label, k.index)).filter((r): r is Range => !!r);
      registry.set(HIGHLIGHT, new Highlight(...ranges));
    };
    const hide = () => registry?.delete(HIGHLIGHT);
    const menuBar = () => !!document.querySelector('[role=menubar]');
    const onKeyDown = (e: KeyboardEvent) => {
      if (menuBar() || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Alt') {
        if (!e.repeat) show();
        e.preventDefault();
        return;
      }
      if (!e.altKey || e.shiftKey) return;
      // The letter the key makes without Alt: from its code where the layout is Latin, else what it types.
      const key = /^Key[A-Z]$|^Digit\d$/.test(e.code) ? e.code.slice(-1).toLowerCase() : e.key.toLowerCase();
      if (!keyed.length) compute();
      const hit = keyed.find((k) => k.key === key);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      hide();
      hit.target.run();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') hide();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', hide);
    };
  }, [enabled]);
}
