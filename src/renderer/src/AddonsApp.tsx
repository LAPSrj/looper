import { useEffect, useState } from 'react';
import type { AddonInfo } from '@shared/addons';
import { useDialogKeys } from './components/hooks';
import { SelectList } from './components/SelectList';

const STATUS: Record<AddonInfo['status'], string> = { starting: 'Starting', running: 'Running', stopped: 'Stopped' };

/** File → Addons…: the installed addons. Install, Start/Stop, Restart and Remove apply at once. */
export function AddonsApp() {
  const [addons, setAddons] = useState<AddonInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Addons';
    void window.looper.addons.list().then((list) => {
      setAddons(list);
      setSelected((s) => s ?? list[0]?.id ?? null);
    });
    return window.looper.addons.onEvent((e) => {
      if (e.type !== 'addons') return;
      setAddons(e.addons);
      setSelected((s) => (s && e.addons.some((a) => a.id === s) ? s : (e.addons[0]?.id ?? null)));
    });
  }, []);

  useDialogKeys({ onCancel: () => window.close() });

  const addon = addons.find((a) => a.id === selected);
  // Stop shows while it runs; Start otherwise, which also brings back one that stopped on its own.
  const running = addon?.status === 'running' || addon?.status === 'starting';

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form env-tab">
          <SelectList
            items={addons}
            label="Addons"
            idPrefix="addon"
            selectedKey={selected}
            itemKey={(a) => a.id}
            itemName={(a) => `${a.name} ${a.version}`}
            itemSub={(a) => STATUS[a.status]}
            empty="No addons"
            onSelect={(a) => setSelected(a.id)}
          />
          <div className="env-actions">
            <button className="btn" onClick={() => void window.looper.addons.install()}>
              Install…
            </button>
            <button className="btn" disabled={!addon} onClick={() => addon && void window.looper.addons.setEnabled(addon.id, !running)}>
              {running ? 'Stop' : 'Start'}
            </button>
            <button className="btn" disabled={!addon?.enabled} onClick={() => addon && void window.looper.addons.restart(addon.id)}>
              Restart
            </button>
            <button className="btn danger" disabled={!addon} onClick={() => addon && void window.looper.addons.remove(addon.id)}>
              Remove
            </button>
          </div>
          {addon && (
            <dl className="props addon-details">
              {addon.description && (
                <>
                  <dt>Description</dt>
                  <dd>{addon.description}</dd>
                </>
              )}
              <dt>Runs</dt>
              <dd className="mono addon-wrap">{addon.run}</dd>
              <dt>Panes</dt>
              <dd>{addon.panes.map((p) => p.title).join(', ') || 'None'}</dd>
              {addon.error && (
                <>
                  <dt>Stopped</dt>
                  <dd className="mono addon-wrap">{addon.error}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      </div>
      <div className="editor-footer">
        <button className="btn" onClick={() => window.close()}>
          Close
        </button>
      </div>
    </div>
  );
}
