import { useEffect, useState } from 'react';
import { Field, FormGroup, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';

/**
 * A window's filter, as a modal child window (a run's messages, an addon's
 * items with the toolbar hidden). OK and Clear Filter hand the value to the
 * main process, which forwards it to the window that opened this one and
 * closes this one.
 */
export function FilterApp({ label, current }: { label: string; current: string }) {
  const [text, setText] = useState(current);

  useEffect(() => {
    document.title = 'Filter';
  }, []);

  const apply = (value: string) => window.looper.applyFilter(value);

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label={label}>
              <TextInput autoFocus value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'OK', run: () => apply(text) }} extras={[{ id: 'clear-filter', label: 'Clear Filter', run: () => apply('') }]} />
    </div>
  );
}
