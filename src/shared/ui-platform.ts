/**
 * Where a menu item, toolbar item or toolbar group shows. `desktop` is the
 * Electron app's windows, `web` the desktop browser's frame, `mobile` the
 * iOS and Android frames (phones and tablets). An item with no list shows
 * everywhere: every feature is meant to work on every device.
 */
export const UI_PLATFORMS = ['desktop', 'web', 'mobile'] as const;
export type UiPlatform = (typeof UI_PLATFORMS)[number];

/** The computer's own windows (a list of them, to bring one forward): a browser's or a phone's are its own. */
export const DESKTOP_ONLY: UiPlatform[] = ['desktop'];
/** Window, pane and toolbar layout, the clipboard Edit menu and the like: nothing a phone can use. */
export const NOT_MOBILE: UiPlatform[] = ['desktop', 'web'];

/** Whether something marked with `platforms` shows on `here`; unmarked shows everywhere. */
export function showsOn(platforms: readonly UiPlatform[] | undefined, here: UiPlatform): boolean {
  return !platforms || platforms.includes(here);
}

/** The UiPlatform of a renderer platform ('electron', 'web', 'ios', 'android') or a remote client's hello platform. */
export function uiPlatformOf(platform: string): UiPlatform {
  if (platform === 'electron' || platform === 'desktop') return 'desktop';
  return platform === 'ios' || platform === 'android' ? 'mobile' : 'web';
}

interface MenuLikeSpec<T> {
  type: string;
  platforms?: UiPlatform[];
  submenu?: T[];
}

/**
 * A menu's items that show on `here`, submenus too, without the separators
 * the hidden ones leave doubled or at an edge. The marks are dropped: what's
 * left shows here.
 */
export function menuForPlatform<T extends MenuLikeSpec<T>>(items: T[], here: UiPlatform): T[] {
  const out: T[] = [];
  for (const it of items) {
    if (!showsOn(it.platforms, here)) continue;
    if (it.type === 'separator') {
      if (out.length && out[out.length - 1].type !== 'separator') out.push(it);
      continue;
    }
    const { platforms: _p, ...rest } = it;
    out.push((it.submenu ? { ...rest, submenu: menuForPlatform(it.submenu, here) } : rest) as T);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}
