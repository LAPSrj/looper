import { isPhone } from '../../web/page-nav';

/**
 * A window's page on a phone runs in an iframe of the tab's frame. This marks
 * it (html.phone-window, which every phone style rule is scoped to, so the
 * frame and the desktop are left alone) and follows the on-screen keyboard:
 *
 * --keyboard-inset: how much of the page the keyboard covers, so the page
 *   shrinks and its bottom bar (a message box, a dialog's buttons, the
 *   terminal's key row) stays right above it. The keyboard shrinks the top
 *   frame's visual viewport, not this iframe, so it's measured there; a frame
 *   that already keeps the iframe above the keyboard makes it 0.
 * html.keyboard-up: the keyboard is up (the main window's tab bar hides under it).
 *
 * The bottom safe area comes from the frame, as --looper-safe-bottom.
 */
function track(): void {
  const root = document.documentElement;
  root.classList.add('phone-window');
  let top: Window;
  try {
    top = window.top ?? window;
    void top.document;
  } catch {
    return;
  }
  const vv = top.visualViewport;
  if (!vv) return;
  const update = () => {
    const up = top.innerHeight - vv.height > 120;
    // Only the keyboard counts: a sheet's iframe sliding in also reaches below the screen for a moment.
    const frame = window.frameElement as HTMLElement | null;
    const bottom = frame ? frame.getBoundingClientRect().bottom : window.innerHeight;
    const inset = up ? Math.max(0, Math.round(bottom - (vv.offsetTop + vv.height))) : 0;
    root.style.setProperty('--keyboard-inset', `${inset}px`);
    root.classList.toggle('keyboard-up', up);
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  // The frame resizes or moves this iframe (a sheet's animation ends, the frame follows the keyboard).
  window.addEventListener('resize', update);
  setTimeout(update, 600);
}

if (isPhone && typeof window !== 'undefined' && window !== window.top) track();
