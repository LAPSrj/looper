/**
 * Size a dialog to its content: the page measures itself and asks (`fitWindow`
 * in the API), and the window takes that page height. Only the desktop's own
 * windows; a window the user resized by hand keeps its size.
 */
import { BrowserWindow, screen } from 'electron';
import type { AppWindow } from './index';
import { fitContentHeight } from './placement';

/** Room a window leaves around itself on its display: the title bar and the taskbar's edge. */
const DISPLAY_MARGIN = 120;

const state = new WeakMap<BrowserWindow, { fitted: boolean; byUser: boolean }>();

export function fitWindowHeight(target: AppWindow | null | undefined, wanted: unknown): void {
  if (!(target instanceof BrowserWindow) || target.isDestroyed() || typeof wanted !== 'number') return;
  if (target.isMaximized() || target.isFullScreen()) return;
  let s = state.get(target);
  if (!s) {
    s = { fitted: false, byUser: false };
    state.set(target, s);
    const mine = s;
    // Only a manual resize emits this; setContentSize below doesn't.
    target.on('will-resize', () => {
      mine.byUser = true;
    });
  }
  if (s.byUser) return;
  const [width, current] = target.getContentSize();
  const area = screen.getDisplayMatching(target.getBounds()).workArea;
  const next = fitContentHeight({ current, wanted, first: !s.fitted, max: area.height - DISPLAY_MARGIN });
  s.fitted = true;
  if (next === null) return;
  // The window's minimum is a floor for fixed-size dialogs; a dialog that needs less lowers it.
  const [minWidth, minHeight] = target.getMinimumSize();
  if (next < minHeight) target.setMinimumSize(minWidth, next);
  target.setContentSize(width, next);
}
