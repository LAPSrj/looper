// No imports and no DOM types: the unit tests (node tsconfig) load this file.

/** An iPhone or iPad, by its user agent; null for any other device. iPadOS reports itself as a Mac, but only it has a touch screen. */
export function appleDevice(ua: string, maxTouchPoints: number): 'iPhone' | 'iPad' | null {
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1)) return 'iPad';
  return null;
}

/** A name for the paired-devices list, guessed from the browser's user agent ("iPhone", "Chrome on Windows"…). */
export function guessDeviceName(ua: string, maxTouchPoints = 0): string {
  const apple = appleDevice(ua, maxTouchPoints);
  if (apple) return apple;
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|Chromium\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux|X11/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}
