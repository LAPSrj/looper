import { useEffect, useState } from 'react';
import type { QRCodeToDataURLOptions } from 'qrcode';
import icon from '../../../assets/icon.png';
import {
  REMOTE_ACCESS_SOURCES,
  SOURCE_NAMES,
  sourceStatusText,
  type PairedDevice,
  type PairingCode,
  type RemoteAccessProviderId,
  type RemoteAccessSourceStatus,
  type RemoteAccessState,
} from '@shared/remote-access';
import type { RemoteAccessSettings } from '@shared/types';
import { CheckboxField, EmptyWindow, Field, FieldRow, FormGroup, NumberInput, SelectInput, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { ListActions, ListButton, SelectList } from './components/SelectList';
import { fmtDateTime } from './format';
import { useRemoteAccessState } from './useRemoteAccess';
import { subscribe } from './events';

const showError = (e: unknown) => void window.looper.showError((e as Error).message);

/** The QR code library loads when a window first draws one, not with the app. */
const toDataURL = (text: string, options: QRCodeToDataURLOptions) => import('qrcode').then((m) => m.toDataURL(text, options));

function deviceSub(d: PairedDevice): string {
  const via = SOURCE_NAMES[d.provider];
  if (d.connected > 0) return `Connected · ${via}`;
  return `${d.lastSeenAt ? `Last used ${fmtDateTime(d.lastSeenAt)}` : 'Not used yet'} · ${via}`;
}

/** A checkbox per source, each with a line after it: its status (Settings) or what it's for (Set Up). */
function SourceRows({
  sources,
  onChange,
  note,
  autoFocus,
}: {
  sources: RemoteAccessProviderId[];
  onChange: (id: RemoteAccessProviderId, on: boolean) => void;
  note: (id: RemoteAccessProviderId) => string;
  autoFocus?: boolean;
}) {
  return (
    <>
      {REMOTE_ACCESS_SOURCES.map((id, i) => (
        <CheckboxField key={id} label={SOURCE_NAMES[id]} note={note(id)} autoFocus={autoFocus && i === 0} checked={sources.includes(id)} onChange={(on) => onChange(id, on)} />
      ))}
    </>
  );
}

/** A source's status for the windows: off while it isn't running, the reason when it fails. */
function sourceLine(state: RemoteAccessState | null, id: RemoteAccessProviderId): string {
  const s = state?.sources.find((x) => x.id === id);
  if (!s) return 'Off';
  if (s.phase === 'error') return s.message ?? 'Not working';
  return sourceStatusText(s);
}

/**
 * Advanced → Remote Access → Settings: a draft, saved with Save or Apply.
 * Remote Access's Turn On / Turn Off menu item is its only switch; this sets
 * how it runs, and shows each source's status as it changes.
 */
export function RemoteAccessSettingsApp() {
  const [draft, setDraft] = useState<RemoteAccessSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const state = useRemoteAccessState();

  useEffect(() => {
    document.title = 'Remote Access';
    void window.looper.info().then(async (info) => {
      const saved = info.settings.remoteAccess;
      const port =
        saved.port ||
        (await window.looper.remoteAccess.suggestPort().catch((e: unknown) => {
          showError(e);
          return 0;
        }));
      setDraft((d) => d ?? { ...saved, port });
    });
  }, []);

  if (!draft) return <EmptyWindow />;

  const set = (patch: Partial<RemoteAccessSettings>) => setDraft({ ...draft, ...patch });

  const doSave = async (): Promise<boolean> => {
    setSaving(true);
    try {
      // On/off is the menu's (Turn On / Turn Off), not this window's: keep whatever it is now.
      const { enabled } = (await window.looper.info()).settings.remoteAccess;
      await window.looper.updateSettings({ remoteAccess: { ...draft, enabled, name: draft.name.trim() } });
      return true;
    } catch (e) {
      showError(e);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = async () => {
    if (await doSave()) window.close();
  };

  const setSource = (id: RemoteAccessProviderId, on: boolean) =>
    set({ sources: REMOTE_ACCESS_SOURCES.filter((s) => (s === id ? on : draft.sources.includes(s))) });

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label="Name">
              <TextInput autoFocus value={draft.name} maxLength={64} placeholder={state?.defaultName} onChange={(e) => set({ name: e.target.value })} />
            </Field>
          </FormGroup>
          <FormGroup title="Sources">
            <SourceRows sources={draft.sources} onChange={setSource} note={(id) => sourceLine(state, id)} />
          </FormGroup>
          <FormGroup>
            <FieldRow>
              {draft.sources.includes('tailscale') && (
                <Field label="Machine name">
                  <TextInput value={draft.hostname} verbatim onChange={(e) => set({ hostname: e.target.value })} />
                </Field>
              )}
              <Field label="Port">
                <NumberInput min={1} max={65535} value={draft.port} onChange={(n) => Number.isInteger(n) && set({ port: n })} />
              </Field>
            </FieldRow>
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Save', run: () => void save() }} apply={{ run: () => void doSave() }} busy={saving} />
    </div>
  );
}

/** Advanced → Remote Access → Paired Devices: the devices that may connect, which change live. */
export function RemoteAccessDevicesApp() {
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Paired Devices';
    void window.looper.remoteAccess.state().then(setState, showError);
    return subscribe((e) => {
      if (e.type === 'remote-access') setState(e.state);
    });
  }, []);

  if (!state) return <EmptyWindow />;

  const device = state.devices.find((d) => d.id === selected);

  // Takes the device it removes: the selected one for the button, the clicked row for the menu.
  const remove = async (target: PairedDevice | undefined = device) => {
    if (!target) return;
    if (!(await window.looper.confirm(`Remove "${target.name}"? It needs a new pairing code to connect again.`))) return;
    try {
      await window.looper.remoteAccess.removeDevice(target.id);
      setSelected(null);
    } catch (e) {
      showError(e);
    }
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form env-tab">
          <SelectList
            items={state.devices}
            label="Paired devices"
            idPrefix="device"
            selectedKey={device ? device.id : null}
            itemKey={(d) => d.id}
            itemName={(d) => d.name}
            itemSub={deviceSub}
            empty="No paired devices"
            onSelect={(d) => setSelected(d.id)}
            onOpen={(d) => void window.looper.remoteAccess.openRename(d.id)}
            autoFocus
            menu={(d) => [
              { label: 'Rename…', run: () => void window.looper.remoteAccess.openRename(d.id) },
              { label: 'Remove', destructive: true, run: () => void remove(d) },
            ]}
            onRename={(d) => void window.looper.remoteAccess.openRename(d.id)}
            onDelete={(d) => void remove(d)}
          />
          <ListActions>
            <ListButton disabled={state.phase !== 'running'} onClick={() => void window.looper.remoteAccess.openPair()}>
              Pair Device…
            </ListButton>
            <ListButton row disabled={!device} onClick={() => device && void window.looper.remoteAccess.openRename(device.id)}>
              Rename…
            </ListButton>
            <ListButton row danger disabled={!device} onClick={() => void remove()}>
              Remove
            </ListButton>
          </ListActions>
        </div>
      </div>
      <WindowActions close />
    </div>
  );
}

/** "ABCD EFGH". */
const groupCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

/** The addresses a device can pair at (one code works at all of them), each a choice in the Pair Device window. */
function pairAddresses(state: RemoteAccessState | null): { label: string; url: string }[] {
  return (state?.sources ?? []).flatMap((s) => (s.phase === 'running' && s.url ? [{ label: SOURCE_NAMES[s.id], url: s.url }] : []));
}

/** Pair Device: a one-time code, as text and as a QR code of its link, renewed as it expires. Closing the window cancels it. */
export function RemoteAccessPairApp() {
  const [code, setCode] = useState<PairingCode | null>(null);
  /** How long the current code lives, for the progress bar. */
  const [lifetime, setLifetime] = useState(0);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<RemoteAccessState | null>(null);
  const [copied, setCopied] = useState(false);
  const [addressIndex, setAddressIndex] = useState(0);
  const addresses = pairAddresses(state);
  const address = addresses[Math.min(addressIndex, addresses.length - 1)];
  const link = code && address ? `${address.url}/pair#${code.code}` : null;

  const newCode = async () => {
    try {
      const next = await window.looper.remoteAccess.pairingCode();
      setLifetime(next.expiresAt - Date.now());
      setCode(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    document.title = 'Pair Device';
    void newCode();
    void window.looper.remoteAccess.state().then(setState, showError);
    return subscribe((e) => {
      if (e.type === 'remote-access') setState(e.state);
    });
  }, []);

  useEffect(() => {
    setQr(null);
    if (!link) return;
    let current = true;
    void toDataURL(link, { margin: 1, width: 220, errorCorrectionLevel: 'M' }).then((url) => current && setQr(url), showError);
    return () => {
      current = false;
    };
  }, [link]);

  const paired = code && state?.pairedWith?.code === code.code ? state.pairedWith.device : null;
  const off = state && state.phase !== 'running';
  const renewing = !!code && !paired && !off;

  const locked = !!code && state?.lockedCode === code.code;

  // A code that runs out, or that wrong tries have locked, is replaced by a new one.
  useEffect(() => {
    if (!renewing || !code) return;
    if (locked) {
      void newCode();
      return;
    }
    const timer = setTimeout(() => void newCode(), Math.max(0, code.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [code, renewing, locked]);

  const copyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      showError(e);
    }
  };

  let body;
  if (paired) body = <p className="pair-message">Paired with {paired.name}.</p>;
  else if (off) body = <p className="pair-message">Remote Access isn't on.</p>;
  else if (error) body = <p className="pair-message">{error}</p>;
  else if (!code) body = <p className="pair-message">Loading…</p>;
  else {
    body = (
      <>
        {addresses.length > 1 && (
          <SelectInput className="pair-source" value={Math.min(addressIndex, addresses.length - 1)} onChange={(e) => setAddressIndex(Number(e.target.value))} aria-label="Address">
            {addresses.map((a, i) => (
              <option key={a.url} value={i}>
                {a.label}
              </option>
            ))}
          </SelectInput>
        )}
        <div className="pair-qr">{qr && <img src={qr} width={220} height={220} alt="QR code of the pairing link" />}</div>
        <div className="pair-code">{groupCode(code.code)}</div>
        <div className="pair-url">
          <span className="pair-address">{address?.url}</span>
          <button className="btn" onClick={() => void copyAddress()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="pair-progress" aria-hidden>
          <div key={code.expiresAt} className="pair-progress-fill" style={{ animationDuration: `${lifetime}ms` }} />
        </div>
      </>
    );
  }

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="pair-body">
          <img className="pair-icon" src={icon} width={48} height={48} alt="" />
          {body}
        </div>
      </div>
      <WindowActions close />
    </div>
  );
}

/** Rename Device, from the paired-devices list. */
export function RemoteAccessRenameApp({ id }: { id: string }) {
  const [name, setName] = useState('');
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    document.title = 'Rename Device';
    void window.looper.remoteAccess.state().then((s) => {
      const d = s.devices.find((x) => x.id === id);
      if (d) {
        setName(d.name);
        setLoaded(true);
      } else setMissing(true);
    }, showError);
    // Keep the draft; only track the device itself (removal).
    return subscribe((e) => {
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

  if (missing) return <EmptyWindow gone="This device is no longer paired." />;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label="Name">
              <TextInput selectWhen={loaded} autoFocus value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Save', run: () => void save(), disabled: !name.trim() }} busy={saving} />
    </div>
  );
}

type SetupStep = 'sources' | 'machine' | 'signin' | 'finish';

const SOURCE_USES: Record<RemoteAccessProviderId, string> = {
  tailscale: 'Your phone and other computers, from anywhere, over your tailnet.',
  local: 'A browser on this computer.',
};

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Advanced → Remote Access → Set Up (and Turn On while no source is chosen):
 * choose the sources, name the machine on the tailnet and sign in to
 * Tailscale; Finish saves the choices, turns Remote Access on and can open
 * Pair Device. Closing it stops the sign-in.
 */
export function RemoteAccessSetupApp() {
  const [sources, setSources] = useState<RemoteAccessProviderId[] | null>(null);
  const [hostname, setHostname] = useState('');
  const [step, setStep] = useState<SetupStep>('sources');
  const [pair, setPair] = useState(true);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const state = useRemoteAccessState();

  useEffect(() => {
    document.title = 'Set Up Remote Access';
    void window.looper.info().then((info) => {
      const ra = info.settings.remoteAccess;
      setSources(ra.sources.length ? ra.sources : ['tailscale']);
      setHostname(ra.hostname);
    }, showError);
  }, []);

  const tailscale = !!sources?.includes('tailscale');
  const steps: SetupStep[] = tailscale ? ['sources', 'machine', 'signin', 'finish'] : ['sources', 'finish'];
  const at = steps.indexOf(step);
  // Remote Access's own Tailscale while it runs one, else Set Up's sign-in.
  const ts: RemoteAccessSourceStatus | undefined = state?.sources.find((s) => s.id === 'tailscale') ?? state?.setup;
  const signedIn = ts?.phase === 'running' && !!ts.account;
  const loginUrl = ts?.phase === 'needs-login' ? ts.loginUrl : undefined;

  // The sign-in step runs Tailscale under the chosen machine name.
  useEffect(() => {
    if (step === 'signin') void window.looper.remoteAccess.beginSignIn(hostname).catch(showError);
  }, [step, hostname]);

  useEffect(() => {
    setQr(null);
    if (!loginUrl) return;
    let current = true;
    void toDataURL(loginUrl, { margin: 1, width: 180, errorCorrectionLevel: 'M' }).then((url) => current && setQr(url), showError);
    return () => {
      current = false;
    };
  }, [loginUrl]);

  const canNext =
    step === 'sources' ? !!sources?.length : step === 'machine' ? HOSTNAME.test(hostname) : step === 'signin' ? signedIn : true;

  const finish = async () => {
    if (!sources) return;
    setBusy(true);
    try {
      await window.looper.remoteAccess.finishSetup({ sources, ...(tailscale ? { hostname } : {}) }, pair);
      window.close();
    } catch (e) {
      showError(e);
      setBusy(false);
    }
  };

  const next = () => {
    if (busy || !canNext) return;
    if (step === 'finish') void finish();
    else setStep(steps[at + 1]);
  };

  if (!sources) return <EmptyWindow />;

  const toggle = (id: RemoteAccessProviderId, on: boolean) => setSources(REMOTE_ACCESS_SOURCES.filter((s) => (s === id ? on : sources.includes(s))));

  let body;
  if (step === 'sources') {
    body = (
      <>
        <h2 className="ra-setup-title">How will devices reach this computer?</h2>
        <FormGroup>
          <SourceRows sources={sources} onChange={toggle} note={(id) => SOURCE_USES[id]} autoFocus />
        </FormGroup>
      </>
    );
  } else if (step === 'machine') {
    body = (
      <>
        <h2 className="ra-setup-title">Name this computer on your tailnet</h2>
        <FormGroup>
          <Field label="Machine name">
            <TextInput autoFocus value={hostname} verbatim onChange={(e) => setHostname(e.target.value.trim())} />
          </Field>
        </FormGroup>
        {!HOSTNAME.test(hostname) && <p className="help error-text">Use lowercase letters, digits and hyphens.</p>}
      </>
    );
  } else if (step === 'signin') {
    let status;
    if (signedIn) status = <p>Signed in as {ts?.account}.</p>;
    else if (ts?.phase === 'error')
      status = (
        <>
          <p className="error-text">{ts.message ?? "Tailscale isn't working."}</p>
          <button className="btn" onClick={() => void window.looper.remoteAccess.beginSignIn(hostname).catch(showError)}>
            Try Again
          </button>
        </>
      );
    else if (loginUrl)
      status = (
        <>
          <p>Open the sign-in page, or scan the code with your phone, and sign in.</p>
          <a className="ra-setup-link" href={loginUrl} target="_blank" rel="noreferrer">
            {loginUrl}
          </a>
          <div className="pair-qr ra-setup-qr">{qr && <img src={qr} width={180} height={180} alt="QR code of the sign-in page" />}</div>
          <p className="muted">Waiting for the sign-in…</p>
        </>
      );
    else status = <p className="muted">Starting Tailscale…</p>;
    body = (
      <>
        <h2 className="ra-setup-title">Sign in to Tailscale</h2>
        {status}
      </>
    );
  } else {
    body = (
      <>
        <h2 className="ra-setup-title">Ready to turn on Remote Access</h2>
        <ul className="ra-setup-summary">
          {sources.map((id) => (
            <li key={id}>
              {SOURCE_NAMES[id]}
              {id === 'tailscale' ? ` as ${hostname}${ts?.account ? `, signed in as ${ts.account}` : ''}` : ''}
            </li>
          ))}
        </ul>
        <FormGroup>
          <CheckboxField label="Pair a device after Finish" checked={pair} onChange={setPair} />
        </FormGroup>
      </>
    );
  }

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form ra-setup">{body}</div>
      </div>
      <WindowActions
        wizard={{ back: { run: () => setStep(steps[at - 1]), disabled: at === 0 }, next: { run: next, disabled: !canNext }, last: step === 'finish' }}
        busy={busy}
      />
    </div>
  );
}
