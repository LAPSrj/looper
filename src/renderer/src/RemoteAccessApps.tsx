import { useEffect, useRef, useState } from 'react';
import { toDataURL } from 'qrcode';
import type { PairedDevice, PairingCode, RemoteAccessState } from '@shared/remote-access';
import type { RemoteAccessSettings, Settings } from '@shared/types';
import { EditorFooter, Field } from './components/ui';
import { useDialogKeys } from './components/hooks';
import { SelectList } from './components/SelectList';
import { fmtDateTime } from './format';

const showError = (e: unknown) => void window.looper.showError((e as Error).message);

/** The status line: what Remote Access is doing now. */
function statusText(s: RemoteAccessState): string {
  switch (s.phase) {
    case 'off':
      return 'Off';
    case 'starting':
      return 'Starting…';
    case 'needs-login':
      return 'Sign in to Tailscale to finish';
    case 'running':
      return `On at ${s.url ?? ''}${s.provider === 'tailscale' && s.account ? ` as ${s.account}` : ''}`;
    case 'error':
      return s.message ?? 'Something went wrong.';
  }
}

function deviceSub(d: PairedDevice): string {
  const via = d.provider === 'tailscale' ? 'Tailscale' : 'This computer only';
  if (d.connected > 0) return `Connected · ${via}`;
  return `${d.lastSeenAt ? `Last used ${fmtDateTime(d.lastSeenAt)}` : 'Not used yet'} · ${via}`;
}

/** Advanced → Remote Access → Settings: the settings are a draft (Save/Apply); the devices change live. */
export function RemoteAccessSettingsApp() {
  const [live, setLive] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<RemoteAccessSettings | null>(null);
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    document.title = 'Remote Access';
    void window.looper.info().then((info) => {
      setLive(info.settings);
      setDraft((d) => d ?? info.settings.remoteAccess);
    });
    void window.looper.remoteAccess.state().then(setState, showError);
    return window.looper.onEvent((e) => {
      if (e.type === 'settings') setLive(e.settings);
      else if (e.type === 'remote-access') setState(e.state);
    });
  }, []);

  const saveRef = useRef<() => Promise<void>>(async () => {});
  useDialogKeys({ onSave: () => void saveRef.current(), onCancel: () => window.close() });

  if (!live || !draft || !state) return <div className="empty">Loading…</div>;

  const set = (patch: Partial<RemoteAccessSettings>) => setDraft({ ...draft, ...patch });
  const devices = state.devices;
  const device = devices.find((d) => d.id === selected);

  const doSave = async (): Promise<boolean> => {
    setSaving(true);
    try {
      await window.looper.updateSettings({ remoteAccess: draft });
      return true;
    } catch (e) {
      showError(e);
      return false;
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = async () => {
    if (await doSave()) window.close();
  };

  const signOut = async () => {
    if (!(await window.looper.confirm('Sign this computer out of Tailscale? Other devices can\'t reach Looper until you sign in again.'))) return;
    setSigningOut(true);
    try {
      await window.looper.remoteAccess.signOut();
    } catch (e) {
      showError(e);
    } finally {
      setSigningOut(false);
    }
  };

  const remove = async () => {
    if (!device) return;
    if (!(await window.looper.confirm(`Remove "${device.name}"? It needs a new pairing code to connect again.`))) return;
    try {
      await window.looper.remoteAccess.removeDevice(device.id);
      setSelected(null);
    } catch (e) {
      showError(e);
    }
  };

  const running = state.phase === 'running';
  const signedIn = running && state.provider === 'tailscale' && !!state.account;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <label className="checkbox-field">
            <input type="checkbox" autoFocus checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            Turn on Remote Access
          </label>
          <Field label="Provider">
            <select value={draft.provider} onChange={(e) => set({ provider: e.target.value as RemoteAccessSettings['provider'] })}>
              <option value="tailscale">Tailscale</option>
              <option value="local">This computer only</option>
            </select>
          </Field>
          <div className="row">
            {draft.provider === 'tailscale' && (
              <Field label="Computer name">
                <input value={draft.hostname} spellCheck={false} onChange={(e) => set({ hostname: e.target.value })} />
              </Field>
            )}
            <Field label="Port" help="0 = any free port">
              <input
                type="number"
                min={0}
                max={65535}
                value={draft.port}
                onChange={(e) => {
                  if (e.target.value === '') return;
                  const n = Number(e.target.value);
                  if (Number.isInteger(n)) set({ port: n });
                }}
              />
            </Field>
          </div>
          <Field label="Status">
            <div className="remote-access-status">
              <span>{statusText(state)}</span>
              {state.phase === 'needs-login' && (
                <button className="btn" onClick={() => void window.looper.remoteAccess.openLogin().catch(showError)}>
                  Sign In…
                </button>
              )}
              {signedIn && (
                <button className="btn" disabled={signingOut} onClick={() => void signOut()}>
                  Sign Out
                </button>
              )}
            </div>
          </Field>
          <Field label="Paired devices">
            <SelectList
              items={devices}
              label="Paired devices"
              idPrefix="device"
              selectedKey={device ? device.id : null}
              itemKey={(d) => d.id}
              itemName={(d) => d.name}
              itemSub={deviceSub}
              empty="No paired devices"
              onSelect={(d) => setSelected(d.id)}
              onOpen={(d) => void window.looper.remoteAccess.openRename(d.id)}
            />
          </Field>
          <div className="env-actions">
            <button className="btn" disabled={!running} onClick={() => void window.looper.remoteAccess.openPair()}>
              Pair Device…
            </button>
            <button className="btn" disabled={!device} onClick={() => device && void window.looper.remoteAccess.openRename(device.id)}>
              Rename…
            </button>
            <button className="btn danger" disabled={!device} onClick={() => void remove()}>
              Remove
            </button>
          </div>
        </div>
      </div>
      <EditorFooter onPrimary={() => void saveRef.current()} onCancel={() => window.close()} onApply={() => void doSave()} saving={saving} />
    </div>
  );
}

/** "ABCD EFGH". */
const groupCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Pair Device: a one-time code, as text and as a QR code of its link. Closing the window cancels it. */
export function RemoteAccessPairApp() {
  const [code, setCode] = useState<PairingCode | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const newCode = async () => {
    try {
      setCode(await window.looper.remoteAccess.pairingCode());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    document.title = 'Pair Device';
    void newCode();
    void window.looper.remoteAccess.state().then(setState, showError);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const off = window.looper.onEvent((e) => {
      if (e.type === 'remote-access') setState(e.state);
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, []);

  useEffect(() => {
    setQr(null);
    if (!code) return;
    let current = true;
    void toDataURL(code.link, { margin: 1, width: 220, errorCorrectionLevel: 'M' }).then((url) => current && setQr(url), showError);
    return () => {
      current = false;
    };
  }, [code]);

  useDialogKeys({ onCancel: () => window.close() });

  const paired = code && state?.pairedWith?.code === code.code ? state.pairedWith.device : null;
  const off = state && state.phase !== 'running';
  const expired = !!code && now >= code.expiresAt;

  let body;
  if (paired) body = <p className="pair-message">Paired with {paired.name}.</p>;
  else if (off) body = <p className="pair-message">Remote Access isn't on.</p>;
  else if (error) body = <p className="pair-message">{error}</p>;
  else if (!code) body = <p className="pair-message">Loading…</p>;
  else {
    body = (
      <>
        <div className="pair-qr">{qr && <img src={qr} width={220} height={220} alt="QR code of the pairing link" />}</div>
        <div className={`pair-code${expired ? ' expired' : ''}`}>{groupCode(code.code)}</div>
        <div className="pair-address">{state?.url}</div>
        {expired ? (
          <div className="pair-expiry">
            <span>This code expired.</span>
            <button className="btn" onClick={() => void newCode()}>
              New Code
            </button>
          </div>
        ) : (
          <div className="pair-expiry">Expires in {fmtRemaining(code.expiresAt - now)}</div>
        )}
      </>
    );
  }

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="pair-body">{body}</div>
      </div>
      <div className="editor-footer">
        <button className="btn primary" autoFocus onClick={() => window.close()}>
          Close
        </button>
      </div>
    </div>
  );
}

/** Rename Device, from the paired-devices list. */
export function RemoteAccessRenameApp({ id }: { id: string }) {
  const [name, setName] = useState('');
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    document.title = 'Rename Device';
    void window.looper.remoteAccess.state().then((s) => {
      const d = s.devices.find((x) => x.id === id);
      if (d) setName(d.name);
      else setMissing(true);
    }, showError);
    // Keep the draft; only track the device itself (removal).
    return window.looper.onEvent((e) => {
      if (e.type === 'remote-access' && !e.state.devices.some((d) => d.id === id)) setMissing(true);
    });
  }, [id]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await window.looper.remoteAccess.renameDevice(id, name);
      window.close();
    } catch (e) {
      showError(e);
      setSaving(false);
    }
  };

  useDialogKeys({ onSave: () => void save(), onCancel: () => window.close() });

  if (missing) return <div className="empty">This device is no longer paired.</div>;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <Field label="Name">
            <input autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
      </div>
      <EditorFooter onPrimary={() => void save()} onCancel={() => window.close()} saving={saving} primaryDisabled={!name.trim()} />
    </div>
  );
}
