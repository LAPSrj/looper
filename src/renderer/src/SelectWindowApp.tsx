import { useEffect, useState } from 'react';
import { SelectList } from './components/SelectList';
import { WindowActions } from './components/WindowActions';

type OpenWindow = { id: number; title: string };

/** Window → More Windows…: every open window, to bring one forward, as Windows' Select Window dialog does past nine. */
export function SelectWindowApp() {
  const [windows, setWindows] = useState<OpenWindow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    document.title = 'Select Window';
    void window.looper.commands.openWindows().then((r) => {
      setWindows(r.windows);
      setSelected(r.current ?? r.windows[0]?.id ?? null);
    });
  }, []);
  const pick = (id: number | null) => {
    if (id !== null) window.looper.commands.showOpenWindow(id);
  };
  return (
    <div className="editor">
      <div className="editor-body">
        <div className="picker-body">
          <SelectList
            items={windows}
            label="Windows"
            idPrefix="win"
            selectedKey={selected === null ? null : String(selected)}
            itemKey={(w) => String(w.id)}
            itemName={(w) => w.title}
            onSelect={(w) => setSelected(w.id)}
            onOpen={(w) => pick(w.id)}
            autoFocus
          />
        </div>
      </div>
      <WindowActions confirm={{ label: 'OK', run: () => pick(selected), disabled: selected === null }} />
    </div>
  );
}
