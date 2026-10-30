import type { PushKeyResponse } from '../../../shared/remote-access';
import { requestHeaders } from './request';

/**
 * unsupported: this browser has no Web Push (or the page isn't a secure context).
 * home-screen: iOS Safari outside a Home Screen app, where Web Push isn't offered.
 * denied: the user blocked notifications for Looper in the browser.
 */
export type PushState = 'unsupported' | 'home-screen' | 'denied' | 'off' | 'on';

const FLAG = 'looper.push';

const isIos = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** Running as a Home Screen (installed) app. */
export const isStandalone = (): boolean =>
  (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;

const supported = (): boolean => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';

/** The service worker, registered once per tab: the browser needs it to install Looper and to get pushes. */
let registration: Promise<ServiceWorkerRegistration | null> | null = null;
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!registration) {
    registration =
      window.isSecureContext && 'serviceWorker' in navigator
        ? navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null)
        : Promise.resolve(null);
  }
  return registration;
}

/** Whether this tab gets Looper's notifications as pushes (so the page needn't show its own). */
export const pushOnHere = (): boolean => {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
};

const setFlag = (on: boolean): void => {
  try {
    if (on) localStorage.setItem(FLAG, '1');
    else localStorage.removeItem(FLAG);
  } catch {
    /* private mode */
  }
};

async function subscription(): Promise<PushSubscription | null> {
  const reg = await registerServiceWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !isStandalone() ? 'home-screen' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const on = Notification.permission === 'granted' && !!(await subscription().catch(() => null));
  setFlag(on);
  return on ? 'on' : 'off';
}

const keyBytes = (b64url: string): Uint8Array<ArrayBuffer> => {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, { method: 'POST', headers: requestHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Looper refused the subscription (${res.status}).`);
}

/**
 * Turn notifications on for this device. Call it straight from the switch's
 * event: Safari asks for permission only inside the user's gesture.
 */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return pushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await registerServiceWorker();
  if (!reg) return 'unsupported';
  await navigator.serviceWorker.ready;
  const res = await fetch('/api/push/key');
  if (!res.ok) throw new Error(`Couldn't get Looper's push key (${res.status}).`);
  const { publicKey } = (await res.json()) as PushKeyResponse;
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another computer's key can't be used here.
  const old = sub?.options.applicationServerKey;
  if (sub && old && btoa(String.fromCharCode(...new Uint8Array(old))) !== btoa(String.fromCharCode(...keyBytes(publicKey)))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await post('/api/push/subscribe', sub.toJSON());
  setFlag(true);
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const sub = await subscription().catch(() => null);
  if (sub) {
    await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  setFlag(false);
  return pushState();
}
