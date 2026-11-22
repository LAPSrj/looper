/**
 * Page zoom for the desktop's windows: Ctrl+= and Ctrl+- (and the numpad keys)
 * step through the browser's zoom levels, Ctrl+0 goes back to 100%, and Ctrl+wheel
 * zooms too. Replacing Electron's default menu removed its zoom roles, and the
 * child windows have no menu, so the keys are handled on every window's page.
 *
 * Each window keeps its own zoom: in Chromium's default zoom mode a zoom belongs to the page's origin, and every
 * Looper window has the same one, so a window opening at its own zoom (Settings at 100%) set the main window's too.
 */
import { BrowserWindow } from 'electron';
import { zoomKey, zoomStep, type ZoomDirection } from './zoom-steps';

/**
 * Make `w`'s page zoomable, starting at `initial` (the last zoom of its kind).
 * `onChange` hears each new factor, to remember it.
 */
export function attachZoom(w: BrowserWindow, initial: number | undefined, onChange: (factor: number) => void): void {
  let factor = initial ?? 1;
  const contents = w.webContents;
  contents.setZoomMode('isolated');
  const apply = (): void => {
    if (!contents.isDestroyed() && contents.getZoomFactor() !== factor) contents.setZoomFactor(factor);
  };
  const step = (direction: ZoomDirection): void => {
    const next = zoomStep(factor, direction);
    if (next === factor) return;
    factor = next;
    apply();
    onChange(factor);
  };
  // A page load resets the zoom to what the browser remembers for the page's origin.
  contents.on('dom-ready', apply);
  contents.on('did-finish-load', apply);
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return;
    const direction = zoomKey(input);
    if (!direction) return;
    event.preventDefault();
    step(direction);
  });
  // Ctrl+wheel.
  contents.on('zoom-changed', (_event, direction) => step(direction));
}
