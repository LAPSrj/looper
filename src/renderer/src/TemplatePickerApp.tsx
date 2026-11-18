import { useEffect, useRef, useState } from 'react';
import type { Task } from '@shared/types';
import { SelectList } from './components/SelectList';
import { Field } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { keptSelection } from './components/selection';
import { subscribe } from './events';

export function TemplatePickerApp() {
  const [templates, setTemplates] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    document.title = 'New Task from Template';
    const apply = (list: Task[]) => {
      setTemplates(list);
      setSelected((s) => keptSelection(s, list, (t) => t.id));
    };
    void window.looper.templates.list().then(apply);
    return subscribe((e) => {
      if (e.type === 'templates') apply(e.templates);
    });
  }, []);

  const create = () => {
    const sel = selectedRef.current;
    if (!sel) return;
    void window.looper.openEditorFromTemplate(sel);
    window.close();
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="picker-body">
          <Field label="Template">
            <SelectList
              items={templates}
              label="Templates"
              idPrefix="tpl"
              selectedKey={selected}
              itemKey={(t) => t.id}
              itemName={(t) => t.name}
              empty="No templates yet."
              onSelect={(t) => setSelected(t.id)}
              onOpen={create}
              autoFocus
            />
          </Field>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Create', run: create, disabled: !selected }} enterAnywhere />
    </div>
  );
}
