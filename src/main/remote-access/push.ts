import webpush from 'web-push';
import type { Logger } from '../../engine/log';
import { readJson, writeJsonAtomic } from '../../engine/store/fsutil';
import type { NotifyTopic, PushPayload, PushSubscribeRequest } from '../../shared/remote-access';
import { waitingOf, type SessionSummary } from '../../shared/sessions';
import type { Clock } from './devices';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface StoredSubscription extends PushSubscribeRequest {
  deviceId: string;
  createdAt: string;
}

interface PushFile {
  vapid?: VapidKeys;
  subscriptions?: unknown;
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** A PushSubscription.toJSON() from a device, checked; null when it isn't one. */
export function parseSubscription(v: unknown): PushSubscribeRequest | null {
  const o = v as Record<string, unknown> | null;
  const keys = o?.keys as Record<string, unknown> | undefined;
  if (!o || typeof o.endpoint !== 'string' || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  if (o.endpoint.length > 2048 || !B64URL.test(keys.p256dh) || !B64URL.test(keys.auth) || keys.p256dh.length > 200 || keys.auth.length > 100) return null;
  try {
    // Push services are always HTTPS; anything else would make this computer post to an address a device chose.
    if (new URL(o.endpoint).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return { endpoint: o.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function isStored(s: unknown): s is StoredSubscription {
  const x = s as Record<string, unknown> | null;
  return !!x && typeof x.deviceId === 'string' && typeof x.createdAt === 'string' && parseSubscription(x) !== null;
}

/**
 * `<dataDir>/remote-access/push.json`: this computer's VAPID keys (made on
 * first use) and the push subscriptions, each kept for the paired device that
 * made it.
 */
export class PushStore {
  private vapidKeys: VapidKeys | undefined;
  private subs: StoredSubscription[];

  constructor(
    private readonly file: string,
    private readonly now: Clock,
    private readonly generateKeys: () => VapidKeys = () => webpush.generateVAPIDKeys(),
  ) {
    let raw: PushFile | null;
    try {
      raw = readJson<PushFile>(file, {});
    } catch {
      raw = null;
    }
    const v = raw?.vapid;
    this.vapidKeys = v && typeof v.publicKey === 'string' && typeof v.privateKey === 'string' ? { publicKey: v.publicKey, privateKey: v.privateKey } : undefined;
    // New keys make every subscription made with the old ones useless.
    this.subs = this.vapidKeys && Array.isArray(raw?.subscriptions) ? raw.subscriptions.filter(isStored) : [];
  }

  vapid(): VapidKeys {
    if (!this.vapidKeys) {
      this.vapidKeys = this.generateKeys();
      this.save();
    }
    return this.vapidKeys;
  }

  list(): StoredSubscription[] {
    return this.subs.map((s) => ({ ...s, keys: { ...s.keys } }));
  }

  forDevices(deviceIds: Iterable<string>): StoredSubscription[] {
    const ids = new Set(deviceIds);
    return this.list().filter((s) => ids.has(s.deviceId));
  }

  /** The device's subscription; one the push service gave another device before (a re-paired phone) moves to it. */
  subscribe(deviceId: string, sub: PushSubscribeRequest): void {
    this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.subs.push({ deviceId, endpoint: sub.endpoint, keys: { ...sub.keys }, createdAt: new Date(this.now()).toISOString() });
    this.save();
  }

  /** Only the device's own subscription goes. */
  unsubscribe(deviceId: string, endpoint: string): boolean {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => !(s.endpoint === endpoint && s.deviceId === deviceId));
    if (this.subs.length === before) return false;
    this.save();
    return true;
  }

  /** The push service said the subscription is gone. */
  drop(endpoint: string): void {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.save();
  }

  /** The device was unpaired: its subscriptions go with it. */
  removeDevice(deviceId: string): number {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.deviceId !== deviceId);
    const n = before - this.subs.length;
    if (n) this.save();
    return n;
  }

  private save(): void {
    writeJsonAtomic(this.file, { vapid: this.vapidKeys, subscriptions: this.subs });
  }
}

export interface SendOptions {
  vapid: VapidKeys;
  /** The VAPID `sub` claim: a mailto: or https: URL. */
  subject: string;
  ttlSeconds: number;
  urgency: 'normal' | 'high';
}

/** Sends one message; rejects with an error carrying the push service's `statusCode` when it refuses. */
export type PushSend = (sub: PushSubscribeRequest, payload: string, o: SendOptions) => Promise<void>;

export const webPushSend: PushSend = async (sub, payload, o) => {
  await webpush.sendNotification(sub, payload, {
    vapidDetails: { subject: o.subject, publicKey: o.vapid.publicKey, privateKey: o.vapid.privateKey },
    TTL: o.ttlSeconds,
    urgency: o.urgency,
  });
};

/** Push services answer these for a subscription that no longer exists. */
const GONE = new Set([404, 410]);

/** Sends push messages to devices, dropping the subscriptions their push service says are gone. */
export class PushSender {
  constructor(
    private readonly store: PushStore,
    private readonly send: PushSend,
    private readonly log: Pick<Logger, 'info' | 'warn'>,
    private readonly subject: () => string,
  ) {}

  async push(deviceIds: Iterable<string>, payload: PushPayload & { badge?: number }, o: { urgency: SendOptions['urgency']; ttlSeconds: number }): Promise<{ sent: number; dropped: number }> {
    const subs = this.store.forDevices(deviceIds);
    if (!subs.length) return { sent: 0, dropped: 0 };
    const body = JSON.stringify(payload);
    const opts: SendOptions = { vapid: this.store.vapid(), subject: this.subject(), ...o };
    let sent = 0;
    let dropped = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await this.send(s, body, opts);
          sent++;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status !== undefined && GONE.has(status)) {
            this.store.drop(s.endpoint);
            dropped++;
            this.log.info(`remote access: dropped a push subscription its service says is gone (${status})`);
          } else {
            this.log.warn(`remote access: push failed${status ? ` (${status})` : ''}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }),
    );
    return { sent, dropped };
  }
}

/** How many sessions waited for the user when each one that `WaitWatcher.next` returned started waiting: the app icon's badge. */
const badges = new WeakMap<SessionSummary, number>();

/** The reasons a session waits that a push tells the user about, and the device switch each falls under. */
const PUSHED_REASONS: Partial<Record<string, NotifyTopic>> = { permission: 'questions', turn: 'turns' };

/** The device switch a waiting session's push falls under. */
export const waitTopic = (s: SessionSummary): NotifyTopic => PUSHED_REASONS[s.waiting?.reason ?? ''] ?? 'turns';

/**
 * How long a finished turn waits before it's pushed: one the agent follows at
 * once with another (a queued message, a background task that ended just
 * then) isn't news yet.
 */
export const TURN_SETTLE_MS = 5_000;

/**
 * The sessions that started waiting for the user since the last state: a new
 * wait (reason and time) on a permission question or a finished turn. A
 * finished turn counts once it has lasted TURN_SETTLE_MS, whatever runs in the
 * background, so a chat notifies once at each turn end, not after each message;
 * a turn that starts before then cancels it. A turn a background task's end
 * starts is a turn of its own, pushed at its end too. A muted session's waits
 * are noted, never pushed.
 */
export class WaitWatcher {
  private seen: Map<string, string> | null = null;

  constructor(private readonly settleMs = TURN_SETTLE_MS) {}

  /** A chat compacted into `to`: its wait was already seen (or pushed) under the old id, so it isn't new under this one. */
  moved(from: string, to: string): void {
    const key = this.seen?.get(from);
    if (key !== undefined) this.seen!.set(to, key);
  }

  /**
   * The first call only records what's already waiting. `retryIn`: a finished
   * turn that will count after this many ms if nothing changes (no new state
   * comes then, so the caller asks again).
   */
  next(sessions: SessionSummary[], now: number): { fresh: SessionSummary[]; retryIn?: number } {
    const kept = new Map<string, string>();
    const fresh: SessionSummary[] = [];
    let retryIn: number | undefined;
    const waiting = waitingOf(sessions).length;
    for (const s of sessions) {
      // Marking a session unread is the user's own doing: no push for it.
      if (!s.waiting || s.waiting.unread || !PUSHED_REASONS[s.waiting.reason]) continue;
      const key = `${s.waiting.reason}:${s.waiting.since}`;
      const before = this.seen?.get(s.id);
      if (this.seen && before !== key && !s.muted && s.waiting.reason === 'turn') {
        const left = s.waiting.since + this.settleMs - now;
        if (left > 0) {
          // Not yet: it stays new until it counts, or until the agent works again.
          if (before !== undefined) kept.set(s.id, before);
          retryIn = Math.min(retryIn ?? left, left);
          continue;
        }
      }
      kept.set(s.id, key);
      if (this.seen && before !== key && !s.muted) {
        fresh.push(s);
        badges.set(s, waiting);
      }
    }
    this.seen = kept;
    return retryIn === undefined ? { fresh } : { fresh, retryIn };
  }
}

export function waitingPayload(s: SessionSummary): PushPayload & { badge?: number } {
  const badge = badges.get(s);
  return {
    title: s.title === 'New chat' || s.title === 'Terminal' ? s.groupName : `${s.groupName}: ${s.title}`,
    body: s.waiting?.text ?? '',
    tag: `session:${s.id}`,
    open: { kind: 'session', id: s.id },
    ...(badge === undefined ? {} : { badge }),
  };
}
