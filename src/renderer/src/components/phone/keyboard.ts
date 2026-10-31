import { isTablet } from '../../web/nav-stack';
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
    // html.tablet: an iPad or Android tablet (the screen's, not this iframe's, size), for its readable widths.
    root.classList.toggle('tablet', isTablet({ width: top.innerWidth, height: top.innerHeight }));
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

const inPhoneWindow = isPhone && typeof window !== 'undefined' && window !== window.top;

if (inPhoneWindow) track();

/**
 * The phone stylesheet is a chunk only a phone's window pages load (the desktop app and the desktop
 * browser never do). It starts loading with the page and `bootWindow` waits for it before the first
 * render, so a window is never drawn unstyled. It goes in as a `<style>` placed before the app's
 * stylesheet, where the `@import` at the top of styles.css used to put it: a plain dynamic CSS
 * import would land after it and win every tie in specificity.
 */
export const phoneStyles: Promise<unknown> = inPhoneWindow
  ? import('../../phone.css?inline').then(({ default: css }) => {
      const style = document.createElement('style');
      style.dataset.phone = '';
      style.textContent = css;
      document.head.insertBefore(style, document.head.querySelector('link[rel="stylesheet"], style'));
    })
  : Promise.resolve();
