/**
 * Page zoom for the desktop's windows: Ctrl+= and Ctrl+- (and the numpad keys)
 * step through the browser's zoom levels, Ctrl+0 goes back to 100%, and Ctrl+wheel
 * zooms too. Replacing Electron's default menu removed its zoom roles, and the
 * child windows have no menu, so the keys are handled on every window's page.
 */
import { BrowserWindow } from 'electron';
import { DESKTOP_ONLY } from '../../shared/ui-platform';
import { zoomKey, zoomStep, type ZoomDirection } from './zoom-steps';

const steppers = new WeakMap<BrowserWindow, (direction: ZoomDirection) => void>();

/**
 * Make `w`'s page zoomable, starting at `initial` (the last zoom of its kind).
 * `onChange` hears each new factor, to remember it.
 */
export function attachZoom(w: BrowserWindow, initial: number | undefined, onChange: (factor: number) => void): void {
  let factor = initial ?? 1;
  const contents = w.webContents;
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
  steppers.set(w, step);
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

/** View → Zoom In / Zoom Out / Actual Size on the focused window. */
export function zoomFocused(direction: ZoomDirection): void {
  const w = BrowserWindow.getFocusedWindow();
  if (w) steppers.get(w)?.(direction);
}

/**
 * The View menu's zoom items. The accelerators only show: the page handles the
 * keys itself (child windows have no menu), so the menu must not take them too.
 */
export function zoomMenuItems(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: 'Zoom &In', accelerator: 'CmdOrCtrl+Plus', registerAccelerator: false, platforms: DESKTOP_ONLY, click: () => zoomFocused('in') },
    { label: 'Zoom &Out', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, platforms: DESKTOP_ONLY, click: () => zoomFocused('out') },
    { label: '&Actual Size', accelerator: 'CmdOrCtrl+0', registerAccelerator: false, platforms: DESKTOP_ONLY, click: () => zoomFocused('reset') },
  ];
}
