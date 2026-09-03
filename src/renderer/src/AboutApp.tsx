import { useEffect, useState } from 'react';
import icon from '../../../assets/icon.png';
import { useDialogKeys } from './components/hooks';

/** Standalone About window (Help → About Looper). */
export function AboutApp() {
  const [version, setVersion] = useState('');
  useEffect(() => {
    document.title = 'About';
    void window.looper.info().then((i) => setVersion(i.version));
  }, []);
  useDialogKeys({ onCancel: () => window.close() });
  return (
    <div className="about">
      <img src={icon} alt="" width={72} height={72} />
      <h1>Looper</h1>
      <div className="muted">Created by Leandro Amorim</div>
      <div className="muted">{version ? `Version ${version}` : ''}</div>
      <button className="btn" onClick={() => window.close()}>
        OK
      </button>
    </div>
  );
}
