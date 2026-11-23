// No DOM types: the unit tests load this file (web/status-bar-tap.ts watches for the tap).

/** How far down the top document waits for the status bar to scroll it back. */
export const PARKED = 1;
/** A drag let go goes on moving for a while; a scroll to the top within this after a touch was the finger's. */
export const AFTER_TOUCH_MS = 1000;
/**
 * The keyboard going (closed from Safari's form bar, with no touch in the page) or a rotation scrolls the document
 * back as the viewport grows: a scroll to the top within this after the window or its visual viewport changed size
 * was that, not the status bar. Taken for a tap, it threw the conversation above a message box to its first message.
 */
export const AFTER_RESIZE_MS = 1000;

/** Whether the top document's scroll was the status bar's tap: back above its parked place, with no finger or resize behind it. */
export function statusBarTapped(s: { scrollY: number; fingers: number; sinceTouch: number; sinceResize: number }): boolean {
  return s.scrollY < PARKED && s.fingers === 0 && s.sinceTouch >= AFTER_TOUCH_MS && s.sinceResize >= AFTER_RESIZE_MS;
}
