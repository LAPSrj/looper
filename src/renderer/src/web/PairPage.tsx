import { useState, type FormEvent, type ReactNode } from 'react';
import type { PairRequest } from '../../../shared/remote-access';
import { platform } from '../platform';
import { requestHeaders } from './request';
import { guessDeviceName } from './device-name';
import { codeFromQr } from './pair-link';
import { canScan } from './pair-scan';
import { QrScanner } from './QrScanner';
import { Field } from '../components/ui';
import { IosField } from './IosField';
import { TitleBar } from './ws-titlebar';
import './phone.css';
import './ios.css';
import './android.css';

/** The code a QR link carries: `<url>/pair#<code>`. */
const linkCode = (): string => codeFromQr(location.href) ?? '';

/** The app's icon, which the server makes for the home screen; hidden where it has none (headless serve). */
function PairLogo() {
  const [shown, setShown] = useState(true);
  if (!shown) return null;
  return <img className="pair-logo" src="/icons/icon-192.png" width={64} height={64} alt="" onError={() => setShown(false)} />;
}

export function PairPage() {
  const [code, setCode] = useState(linkCode);
  const [name, setName] = useState(() => guessDeviceName(navigator.userAgent, navigator.maxTouchPoints));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const scan = canScan();

  function submit(e: FormEvent) {
    e.preventDefault();
    void pair(code);
  }

  async function pair(value: string) {
    setBusy(true);
    setError('');
    try {
      const body: PairRequest = { code: value.trim(), name: name.trim() };
      const res = await fetch('/api/pair', { method: 'POST', headers: requestHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
      if (res.ok) {
        location.replace('/');
        return;
      }
      setError(
        res.status === 401
          ? 'That code is wrong or has expired.'
          : res.status === 429
            ? 'Too many wrong codes. Make a new code on the host computer.'
            : `Couldn't pair this device (${res.status}).`,
      );
    } catch {
      setError("Couldn't reach Looper.");
    }
    setBusy(false);
  }

  const codeInput = (className?: string) => (
    <input
      className={className}
      value={code}
      onChange={(e) => setCode(e.target.value)}
      autoCapitalize="characters"
      autoCorrect="off"
      autoComplete="one-time-code"
      spellCheck={false}
      autoFocus={!code}
    />
  );
  const nameInput = (className?: string) => <input className={className} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!!code} />;

  const scanner = (buttonClass: string) =>
    scanning && (
      <QrScanner
        buttonClass={buttonClass}
        onClose={() => setScanning(false)}
        onError={(message) => {
          setScanning(false);
          setError(message);
        }}
        onCode={(scanned) => {
          setScanning(false);
          setCode(scanned);
          void pair(scanned);
        }}
      />
    );

  const look = platform === 'ios' ? IOS : platform === 'android' ? ANDROID : DESKTOP;
  const body = (
    <>
      <PairLogo />
      {look.heading}
      {look.fields(look.field(look.labels.code, codeInput('mono')), look.field(look.labels.name, nameInput()))}
      {scan && look.scan(() => setScanning(true))}
      {error && (
        <div className={look.error} role="alert">
          {error}
        </div>
      )}
    </>
  );
  const pairButton = (
    <button type="submit" className={look.submit} disabled={busy || !code.trim()}>
      Pair
    </button>
  );

  if (look !== DESKTOP) {
    return (
      <>
        <form className={look.form} onSubmit={submit}>
          {body}
          {pairButton}
        </form>
        {scanner(look.scanner)}
      </>
    );
  }
  // The pairing page shows before any window: Pair is its one button, with nothing to cancel back to.
  return (
    <div className="pair-page">
      <form className={look.form} onSubmit={submit}>
        <TitleBar title="Looper" />
        <div className="pair-page-body">{body}</div>
        <div className="editor-footer">{pairButton}</div>
      </form>
      {scanner(look.scanner)}
    </div>
  );
}

/** How each platform draws the pairing form. */
interface PairLook {
  form: string;
  heading: ReactNode;
  labels: { code: string; name: string };
  field: (label: string, input: ReactNode) => ReactNode;
  fields: (code: ReactNode, name: ReactNode) => ReactNode;
  scan: (onClick: () => void) => ReactNode;
  error: string;
  submit: string;
  /** The scanner's Cancel button. */
  scanner: string;
}

const IOS: PairLook = {
  form: 'ph-pair ios',
  heading: <h1 className="ios-large-title">Pair This Device</h1>,
  labels: { code: 'Code', name: 'Name' },
  field: (label, input) => <IosField label={label}>{input}</IosField>,
  fields: (code, name) => (
    <div className="ios-group">
      {code}
      {name}
    </div>
  ),
  scan: (onClick) => (
    <div className="ios-group">
      <button type="button" className="ios-cell ios-cell-button" onClick={onClick}>
        Scan QR Code
      </button>
    </div>
  ),
  error: 'ios-group-footer error',
  submit: 'ios-filled-btn wide',
  scanner: 'ios-filled-btn',
};

const ANDROID: PairLook = {
  form: 'ph-pair android',
  heading: <h1 className="md-headline">Pair this device</h1>,
  labels: { code: 'Pairing code', name: 'Device name' },
  field: (label, input) => (
    <label className="md-field">
      <span className="md-field-label">{label}</span>
      {input}
    </label>
  ),
  fields: (code, name) => (
    <>
      {code}
      {name}
    </>
  ),
  scan: (onClick) => (
    <button type="button" className="md-text-btn" onClick={onClick}>
      Scan QR Code
    </button>
  ),
  error: 'md-error-text',
  submit: 'md-filled-btn wide',
  scanner: 'md-filled-btn',
};

const DESKTOP: PairLook = {
  form: 'pair-card',
  heading: <h1>Pair this device</h1>,
  labels: { code: 'Pairing code', name: 'Device name' },
  field: (label, input) => <Field label={label}>{input}</Field>,
  fields: ANDROID.fields,
  scan: (onClick) => (
    <button type="button" className="btn" onClick={onClick}>
      Scan QR Code
    </button>
  ),
  error: 'pair-page-error',
  submit: 'btn primary',
  scanner: 'btn primary',
};
