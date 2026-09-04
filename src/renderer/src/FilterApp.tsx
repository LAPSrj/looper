import { useEffect, useState } from 'react';
import { useDialogKeys } from './components/hooks';
import { EditorFooter, Field } from './components/ui';

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
  useDialogKeys({ onSave: () => apply(text), onCancel: () => window.close() });

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <Field label="Show messages containing">
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        </div>
      </div>
      <EditorFooter
        primaryLabel="OK"
        onPrimary={() => apply(text)}
        onCancel={() => window.close()}
        onApply={() => apply('')}
        applyLabel="Clear Filter"
      />
    </div>
  );
}
