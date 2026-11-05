import { useEffect, useState } from 'react';
import { Field, FormGroup, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';

/**
 * The conversation window's filter, as a modal child window. OK and Clear
 * Filter hand the value to the main process, which forwards it to the parent
 * conversation window and closes this one.
 */
export function FilterApp({ current }: { current: string }) {
  const [text, setText] = useState(current);

  useEffect(() => {
    document.title = 'Filter';
  }, []);

  const apply = (value: string) => window.looper.applyMessagesFilter(value);

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label="Show messages containing">
              <TextInput autoFocus value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'OK', run: () => apply(text) }} extras={[{ id: 'clear-filter', label: 'Clear Filter', run: () => apply('') }]} />
    </div>
  );
}
