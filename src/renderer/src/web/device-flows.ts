import { useEffect, useRef, useState } from 'react';
import type { MeResponse } from '../../../shared/remote-access';
import type { ShellController } from './controller';
import { useLocalMessage, type LocalMessage } from './file-flows';
import { disablePush, enablePush, pushState, type PushState } from './push-client';
import { requestHeaders } from './request';

export interface ThisDevice {
  /** The name this device was paired as ('' until known). */
  name: string;
  /** The computer's address, as this browser reaches it. */
  computer: string;
  push: PushState | null;
  busy: boolean;
  /** The Notifications switch: call it from the switch's own event (permission needs the gesture). */
  setNotifications: (on: boolean) => void;
  unpair: () => void;
  message: LocalMessage | null;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The This Device sheet or window: its name, the computer it's paired with, notifications, and unpairing. */
export function useThisDevice(controller: ShellController): ThisDevice {
  const [name, setName] = useState('');
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, ask] = useLocalMessage();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void fetch('/api/me')
      .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
      .then((me) => alive.current && me?.device && setName(me.device.name))
      .catch(() => undefined);
    void pushState().then((s) => alive.current && setPush(s));
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = (err: unknown) => void ask({ type: 'error', title: 'Looper', message: errorText(err), buttons: ['OK'] });

  return {
    name,
    computer: location.host,
    push,
    busy,
    setNotifications: (on) => {
      setBusy(true);
      // enablePush asks for permission first thing, still inside this gesture.
      (on ? enablePush() : disablePush())
        .then((s) => alive.current && setPush(s))
        .catch((err) => {
          fail(err);
          void pushState().then((s) => alive.current && setPush(s));
        })
        .finally(() => alive.current && setBusy(false));
    },
    unpair: () => {
      void ask({
        type: 'warning',
        title: 'Unpair This Device',
        message: 'Unpair this device?',
        detail: 'To use Looper here again, pair it with a new code from the computer.',
        buttons: ['Unpair', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      }).then(async (r) => {
        if (r !== 0) return;
        try {
          await disablePush().catch(() => undefined);
          const res = await fetch('/api/unpair', { method: 'POST', headers: requestHeaders() });
          if (!res.ok && res.status !== 401) throw new Error(`Couldn't unpair this device (${res.status}).`);
          controller.session.stop();
          location.replace('/');
        } catch (err) {
          fail(err);
        }
      });
    },
    message,
  };
}
