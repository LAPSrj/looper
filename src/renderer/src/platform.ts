import { appleDevice } from './web/device-name';

export type Platform = 'electron' | 'web' | 'ios' | 'android';

const OVERRIDE_KEY = 'looper.platform';
const OVERRIDES = ['ios', 'android', 'web'];

/** True when the preload exposed `window.looper` before any page script ran, so this is the desktop app. */
const hasPreload = typeof window !== 'undefined' && !!(window as { looper?: unknown }).looper;

function detect(): Platform {
  if (hasPreload) return 'electron';
  // An iframe takes the platform of the tab it's in.
  if (window !== window.top) {
    const fromTop = (window.top as unknown as { __looperSession?: { platform: Platform } }).__looperSession?.platform;
    if (fromTop) return fromTop;
  }
  const fromQuery = new URLSearchParams(window.location.search).get('platform');
  if (fromQuery && OVERRIDES.includes(fromQuery)) sessionStorage.setItem(OVERRIDE_KEY, fromQuery);
  const override = sessionStorage.getItem(OVERRIDE_KEY);
  if (override && OVERRIDES.includes(override)) return override as Platform;
  if (appleDevice(navigator.userAgent, navigator.maxTouchPoints)) return 'ios';
  if (/Android/.test(navigator.userAgent)) return 'android';
  return 'web';
}

export const platform: Platform = detect();

export const isTouch = platform === 'ios' || platform === 'android' || (platform === 'web' && navigator.maxTouchPoints > 0);

document.documentElement.dataset.platform = platform;
