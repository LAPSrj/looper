import { useEffect, useRef, useState } from 'react';
import type { Task } from '@shared/types';
import { useDialogKeys } from './components/hooks';
import { SelectList } from './components/SelectList';
import { EditorFooter } from './components/ui';

export function TemplatePickerApp() {
  const [templates, setTemplates] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    document.title = 'New Task from Template';
    void window.looper.templates.list().then((t) => {
      setTemplates(t);
      if (t.length > 0) setSelected(t[0].id);
    });
    return window.looper.onEvent((e) => {
      if (e.type === 'templates') {
        setTemplates(e.templates);
        setSelected((s) => (s && e.templates.some((t) => t.id === s) ? s : e.templates[0]?.id ?? null));
      }
    });
  }, []);

  const create = () => {
    const sel = selectedRef.current;
    if (!sel) return;
    void window.looper.openEditorFromTemplate(sel);
    window.close();
  };

  useDialogKeys({ onSave: create, onCancel: () => window.close(), enterAnywhere: true });

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="picker-body">
          <div className="field">
            <label className="field-label">Template</label>
            {templates.length === 0 ? (
              <div className="empty">No templates. Create one in File → Templates.</div>
            ) : (
              <SelectList
                items={templates}
                label="Templates"
                idPrefix="tpl"
                selectedKey={selected}
                itemKey={(t) => t.id}
                itemName={(t) => t.name}
                onSelect={(t) => setSelected(t.id)}
                onOpen={create}
              />
            )}
          </div>
        </div>
      </div>
      <EditorFooter primaryLabel="Create" onPrimary={create} primaryDisabled={!selected} onCancel={() => window.close()} />
    </div>
  );
}
