import crypto from 'node:crypto';
import type { RemoteAccessProviderId } from '../../shared/remote-access';
import { readJson, writeJsonAtomic } from '../../engine/store/fsutil';

/** Milliseconds since the epoch; tests pass their own. */
export type Clock = () => number;

export const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 5 * 60_000;
/** Wrong tries a code takes in total before it stops working. */
export const PAIRING_MAX_WRONG = 5;
/** How often a device's lastSeenAt is written to disk at most. */
const LAST_SEEN_WRITE_MS = 60_000;

export interface StoredDevice {
  id: string;
  name: string;
  /** The provider it was paired under: its cookie works only while that one is active. */
  provider: RemoteAccessProviderId;
  /** sha256 hex of the token secret. */
  tokenHash: string;
  pairedAt: string;
  lastSeenAt?: string;
}

const sha256 = (s: string): Buffer => crypto.createHash('sha256').update(s, 'utf8').digest();

/** Constant-time string comparison (both sides hashed, so lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

/** A device name as the list shows it: one line, at most 64 characters. */
export function cleanDeviceName(name: unknown): string {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return s.slice(0, 64) || 'Device';
}

function isStoredDevice(d: unknown): d is StoredDevice {
  const x = d as Record<string, unknown> | null;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.name === 'string' &&
    (x.provider === 'tailscale' || x.provider === 'local') &&
    typeof x.tokenHash === 'string' &&
    /^[0-9a-f]{64}$/.test(x.tokenHash) &&
    typeof x.pairedAt === 'string' &&
    (x.lastSeenAt === undefined || typeof x.lastSeenAt === 'string')
  );
}

/** Paired devices in `devices.json`; each holds a token whose hash is all that's stored. */
export class DeviceStore {
  private devices: StoredDevice[];
  private lastWrite = new Map<string, number>();

  constructor(
    private readonly file: string,
    private readonly now: Clock,
  ) {
    let raw: { devices?: unknown } | null;
    try {
      raw = readJson<{ devices?: unknown }>(file, { devices: [] });
    } catch {
      // Unreadable: the devices pair again.
      raw = null;
    }
    this.devices = Array.isArray(raw?.devices) ? raw.devices.filter(isStoredDevice) : [];
  }

  list(): StoredDevice[] {
    return this.devices.map((d) => ({ ...d }));
  }

  get(id: string): StoredDevice | undefined {
    return this.devices.find((d) => d.id === id);
  }

  /** A new device; the cookie value (`<id>.<secret>`) is returned only here. */
  add(name: string, provider: RemoteAccessProviderId): { device: StoredDevice; cookie: string } {
    const id = crypto.randomBytes(9).toString('base64url');
    const secret = crypto.randomBytes(32).toString('base64url');
    const device: StoredDevice = {
      id,
      name: cleanDeviceName(name),
      provider,
      tokenHash: sha256(secret).toString('hex'),
      pairedAt: new Date(this.now()).toISOString(),
    };
    this.devices.push(device);
    this.save();
    return { device: { ...device }, cookie: `${id}.${secret}` };
  }

  /** The device a cookie value belongs to, or undefined; also undefined when it was paired under another provider. */
  verify(cookie: string | undefined, provider: RemoteAccessProviderId): StoredDevice | undefined {
    if (!cookie) return undefined;
    const dot = cookie.indexOf('.');
    if (dot <= 0) return undefined;
    const device = this.get(cookie.slice(0, dot));
    if (!device || device.provider !== provider) return undefined;
    const given = sha256(cookie.slice(dot + 1));
    const stored = Buffer.from(device.tokenHash, 'hex');
    return crypto.timingSafeEqual(given, stored) ? device : undefined;
  }

  /** Mark the device used now; written to disk at most once a minute (or with `force`). */
  touch(id: string, force = false): void {
    const d = this.get(id);
    if (!d) return;
    const now = this.now();
    d.lastSeenAt = new Date(now).toISOString();
    if (force || now - (this.lastWrite.get(id) ?? 0) >= LAST_SEEN_WRITE_MS) {
      this.lastWrite.set(id, now);
      this.save();
    }
  }

  rename(id: string, name: string): boolean {
    const d = this.get(id);
    if (!d) return false;
    d.name = cleanDeviceName(name);
    this.save();
    return true;
  }

  remove(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.lastWrite.delete(id);
    this.save();
    return true;
  }

  save(): void {
    writeJsonAtomic(this.file, { devices: this.devices });
  }
}

/** A code as the user may type it: any case, with spaces and dashes. */
export function normalizeCode(input: unknown): string {
  return typeof input === 'string' ? input.toUpperCase().replace(/[\s-]+/g, '') : '';
}

export type PairCheck = 'ok' | 'wrong' | 'locked' | 'none';

/** The one active pairing code: it expires, works once, and locks after PAIRING_MAX_WRONG wrong tries. */
export class Pairing {
  private current: { code: string; expiresAt: number; wrong: number } | null = null;

  /** `onLocked` runs when a wrong try is the one that locks the code. */
  constructor(
    private readonly now: Clock,
    private readonly onLocked?: () => void,
  ) {}

  /** Make a new code, replacing the one before. */
  newCode(): { code: string; expiresAt: number } {
    let code = '';
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) code += PAIRING_ALPHABET[crypto.randomInt(PAIRING_ALPHABET.length)];
    this.current = { code, expiresAt: this.now() + PAIRING_TTL_MS, wrong: 0 };
    return { code, expiresAt: this.current.expiresAt };
  }

  cancel(): void {
    this.current = null;
  }

  /** The code still taking tries, if any. */
  active(): { code: string; expiresAt: number } | null {
    const c = this.current;
    if (!c || this.now() >= c.expiresAt || c.wrong >= PAIRING_MAX_WRONG) return null;
    return { code: c.code, expiresAt: c.expiresAt };
  }

  /** The current code while it's locked by wrong tries (it doesn't expire out of this), else null. */
  lockedCode(): string | null {
    const c = this.current;
    return c && c.wrong >= PAIRING_MAX_WRONG ? c.code : null;
  }

  /** Try a code; 'ok' uses it up. */
  check(input: unknown): PairCheck {
    const c = this.current;
    if (!c || this.now() >= c.expiresAt) return 'none';
    if (c.wrong >= PAIRING_MAX_WRONG) return 'locked';
    if (safeEqual(normalizeCode(input), c.code)) {
      this.current = null;
      return 'ok';
    }
    c.wrong++;
    if (c.wrong >= PAIRING_MAX_WRONG) this.onLocked?.();
    return 'wrong';
  }
}
