import { useState, type FormEvent } from 'react';
import type { PairRequest } from '../../../shared/remote-access';
import { platform } from '../platform';
import { requestHeaders } from './request';
import { guessDeviceName } from './device-name';
import './phone.css';
import './ios.css';
import './android.css';

/** The code a QR link carries: `<url>/pair#<code>`. */
const linkCode = (): string => (location.pathname === '/pair' ? decodeURIComponent(location.hash.replace(/^#/, '')) : '');

export function PairPage() {
  const [code, setCode] = useState(linkCode);
  const [name, setName] = useState(() => guessDeviceName(navigator.userAgent, navigator.maxTouchPoints));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body: PairRequest = { code: code.trim(), name: name.trim() };
      const res = await fetch('/api/pair', { method: 'POST', headers: requestHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
      if (res.ok) {
        location.replace('/');
        return;
      }
      setError(
        res.status === 401
          ? 'That code is wrong or has expired.'
          : res.status === 429
            ? 'Too many wrong codes. Make a new code on the computer.'
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

  if (platform === 'ios') {
    return (
      <form className="ph-pair ios" onSubmit={submit}>
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
        {error && (
          <div className="ios-group-footer error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="ios-filled-btn wide" disabled={busy || !code.trim()}>
          Pair
        </button>
      </form>
    );
  }

  if (platform === 'android') {
    return (
      <form className="ph-pair android" onSubmit={submit}>
        <h1 className="md-headline">Pair this device</h1>
        <label className="md-field">
          <span className="md-field-label">Pairing code</span>
          {codeInput('mono')}
        </label>
        <label className="md-field">
          <span className="md-field-label">Device name</span>
          {nameInput()}
        </label>
        {error && (
          <div className="md-error-text" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="md-filled-btn wide" disabled={busy || !code.trim()}>
          Pair
        </button>
      </form>
    );
  }

  return (
    <div className="pair-page">
      <form className="pair-card" onSubmit={submit}>
        <div className="ws-titlebar">
          <span className="ws-title">Looper</span>
        </div>
        <div className="pair-page-body">
          <h1>Pair this device</h1>
          <label className="field">
            <span className="field-label">Pairing code</span>
            {codeInput('mono')}
          </label>
          <label className="field">
            <span className="field-label">Device name</span>
            {nameInput()}
          </label>
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
    </div>
  );
}
