import { useEffect, useRef, useState } from 'react';
import type { MeResponse, RenameRequest } from '../../../shared/remote-access';
import type { ShellController } from './controller';
import { useLocalMessage, type LocalMessage } from './file-flows';
import { disablePush, enablePush, pushState, type PushState } from './push-client';
import { requestHeaders } from './request';

export interface ThisDevice {
  /** The name this device was paired as ('' until known). */
  name: string;
  /** The computer's name ('' until known). */
  computer: string;
  push: PushState | null;
  busy: boolean;
  /** The Notifications switch: call it from the switch's own event (permission needs the gesture). Resolves false when it failed (the error is shown). */
  setNotifications: (on: boolean) => Promise<boolean>;
  /** Rename this device on the computer (its Paired Devices list follows). Resolves false when it failed (the error is shown). */
  rename: (name: string) => Promise<boolean>;
  unpair: () => void;
  message: LocalMessage | null;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The This Device sheet or window: its name, the computer it's paired with, notifications, and unpairing. */
export function useThisDevice(controller: ShellController): ThisDevice {
  const [name, setName] = useState('');
  const [computer, setComputer] = useState('');
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, ask] = useLocalMessage();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void fetch('/api/me')
      .then((r) => (r.ok ? (r.json() as Promise<MeResponse>) : null))
      .then((me) => {
        if (!alive.current || !me?.device) return;
        setName(me.device.name);
        setComputer(me.computer ?? '');
      })
      .catch(() => undefined);
    void pushState().then((s) => alive.current && setPush(s));
    const offShell = controller.session.onShell((m) => {
      if (m.t === 'computer') setComputer(m.name);
    });
    return () => {
      alive.current = false;
      offShell();
    };
  }, [controller]);

  const fail = (err: unknown) => void ask({ type: 'error', title: 'Looper', message: errorText(err), buttons: ['OK'] });

  return {
    name,
    computer,
    push,
    busy,
    setNotifications: (on) => {
      setBusy(true);
      // enablePush asks for permission first thing, still inside this gesture.
      return (on ? enablePush() : disablePush())
        .then((s) => {
          if (alive.current) setPush(s);
          return true;
        })
        .catch((err) => {
          fail(err);
          void pushState().then((s) => alive.current && setPush(s));
          return false;
        })
        .finally(() => alive.current && setBusy(false));
    },
    rename: async (next) => {
      setBusy(true);
      try {
        const body: RenameRequest = { name: next.trim() };
        const res = await fetch('/api/rename', { method: 'POST', headers: requestHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
        if (!res.ok) throw new Error(res.status === 400 ? await res.text() : `Couldn't rename this device (${res.status}).`);
        const me = (await res.json()) as MeResponse;
        if (alive.current && me.device) setName(me.device.name);
        return true;
      } catch (err) {
        fail(err);
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    unpair: () => {
      void ask({
        type: 'warning',
        title: 'Unpair This Device',
        message: 'Unpair this device?',
        detail: 'To use Looper here again, pair it with a new code from the host computer.',
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
