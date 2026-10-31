import { useState, type FormEvent } from 'react';
import type { PairRequest } from '../../../shared/remote-access';
import { platform } from '../platform';
import { requestHeaders } from './request';
import { guessDeviceName } from './device-name';
import { codeFromQr } from './pair-link';
import { canScan } from './pair-scan';
import { QrScanner } from './QrScanner';
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

  if (platform === 'ios') {
    return (
      <>
        <form className="ph-pair ios" onSubmit={submit}>
          <PairLogo />
          <h1 className="ios-large-title">Pair This Device</h1>
          <div className="ios-group">
            <label className="ios-cell ios-field">
              <span className="ios-cell-label">Code</span>
              {codeInput('mono')}
            </label>
            <label className="ios-cell ios-field">
              <span className="ios-cell-label">Name</span>
              {nameInput()}
            </label>
          </div>
          {scan && (
            <div className="ios-group">
              <button type="button" className="ios-cell ios-cell-button" onClick={() => setScanning(true)}>
                Scan QR Code
              </button>
            </div>
          )}
          {error && (
            <div className="ios-group-footer error" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="ios-filled-btn wide" disabled={busy || !code.trim()}>
            Pair
          </button>
        </form>
        {scanner('ios-filled-btn')}
      </>
    );
  }

  if (platform === 'android') {
    return (
      <>
        <form className="ph-pair android" onSubmit={submit}>
          <PairLogo />
          <h1 className="md-headline">Pair this device</h1>
          <label className="md-field">
            <span className="md-field-label">Pairing code</span>
            {codeInput('mono')}
          </label>
          <label className="md-field">
            <span className="md-field-label">Device name</span>
            {nameInput()}
          </label>
          {scan && (
            <button type="button" className="md-text-btn" onClick={() => setScanning(true)}>
              Scan QR Code
            </button>
          )}
          {error && (
            <div className="md-error-text" role="alert">
              {error}
            </div>
          )}
          <button type="submit" className="md-filled-btn wide" disabled={busy || !code.trim()}>
            Pair
          </button>
        </form>
        {scanner('md-filled-btn')}
      </>
    );
  }

  return (
    <div className="pair-page">
      <form className="pair-card" onSubmit={submit}>
        <div className="ws-titlebar">
          <span className="ws-title">Looper</span>
        </div>
        <div className="pair-page-body">
          <PairLogo />
          <h1>Pair this device</h1>
          <label className="field">
            <span className="field-label">Pairing code</span>
            {codeInput('mono')}
          </label>
          <label className="field">
            <span className="field-label">Device name</span>
            {nameInput()}
          </label>
          {scan && (
            <button type="button" className="btn" onClick={() => setScanning(true)}>
              Scan QR Code
            </button>
          )}
          {error && (
            <div className="pair-page-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="editor-footer">
          <button type="submit" className="btn primary" disabled={busy || !code.trim()}>
            Pair
          </button>
        </div>
      </form>
      {scanner('btn primary')}
    </div>
  );
}
