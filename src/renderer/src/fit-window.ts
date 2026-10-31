import { useEffect } from 'react';
import { uiHere } from './web/page-nav';

/** The height of an `.editor` page with every panel at its natural size, footer and tab bar included. */
export function naturalEditorHeight(editor: HTMLElement): number {
  let total = 0;
  for (const child of Array.from(editor.children) as HTMLElement[]) {
    total += child.classList.contains('editor-body') ? naturalBodyHeight(child) : child.offsetHeight;
  }
  return total;
}

/** The tallest of the body's forms: its last element's bottom edge and bottom margin, plus the form's bottom padding. */
function naturalBodyHeight(body: HTMLElement): number {
  let tallest = 0;
  for (const form of Array.from(body.querySelectorAll<HTMLElement>('.form'))) {
    const last = form.lastElementChild;
    if (!last) continue;
    const top = form.getBoundingClientRect().top - form.scrollTop;
    const margin = parseFloat(getComputedStyle(last).marginBottom || '0');
    const bottom = last.getBoundingClientRect().bottom + margin + parseFloat(getComputedStyle(form).paddingBottom || '0');
    tallest = Math.max(tallest, bottom - top);
  }
  return Math.ceil(tallest);
}

/**
 * Ask the desktop for a window that fits this dialog's content, so it opens with
 * no scroll bar and no empty band. Runs after every render and asks only when
 * the height changed; the desktop sizes the window to the first answer and
 * grows it after that (a tab or a revealed field that needs more room), never
 * shrinks it, and leaves a window the user resized alone.
 */
export function useFitWindow(): void {
  useEffect(() => {
    if (uiHere !== 'desktop') return;
    const editor = document.querySelector<HTMLElement>('.editor');
    if (!editor) return;
    const frame = requestAnimationFrame(() => {
      const wanted = naturalEditorHeight(editor);
      if (wanted > 0 && wanted !== lastAsked) {
        lastAsked = wanted;
        window.looper.fitWindow(wanted);
      }
    });
    return () => cancelAnimationFrame(frame);
  });
}

let lastAsked = 0;
