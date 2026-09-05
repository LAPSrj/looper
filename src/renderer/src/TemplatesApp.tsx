import { useEffect, useState } from 'react';
import type { Task } from '@shared/types';
import { useDialogKeys } from './components/hooks';
import { SelectList, ListActions } from './components/SelectList';

const rid = () => Math.random().toString(36).slice(2, 8);

/** Standalone template manager window (File → Templates…). All actions apply immediately. */
export function TemplatesApp() {
  const [templates, setTemplates] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Templates';
    void window.looper.templates.list().then((t) => {
      setTemplates(t);
      setSelected((s) => s ?? t[0]?.id ?? null);
    });
    return window.looper.onEvent((e) => {
      if (e.type === 'templates') {
        setTemplates(e.templates);
        setSelected((s) => (s && e.templates.some((t) => t.id === s) ? s : e.templates[0]?.id ?? null));
      }
    });
  }, []);

  useDialogKeys({ onCancel: () => window.close() });

  const tpl = templates.find((t) => t.id === selected);

  const duplicate = async () => {
    if (!tpl) return;
    const copy = {
      ...JSON.parse(JSON.stringify(tpl)),
      id: `${tpl.id}-${rid()}`,
      name: `${tpl.name} (copy)`,
    };
    delete copy.createdAt;
    delete copy.updatedAt;
    try {
      await window.looper.templates.save(copy);
      setSelected(copy.id);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!tpl) return;
    if (!(await window.looper.confirm(`Remove template "${tpl.name}"?`))) return;
    try {
      await window.looper.templates.remove(tpl.id);
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form env-tab">
          <SelectList
            items={templates}
            label="Templates"
            idPrefix="tpl"
            selectedKey={selected}
            itemKey={(t) => t.id}
            itemName={(t) => t.name}
            empty="No templates"
            onSelect={(t) => setSelected(t.id)}
            onOpen={(t) => void window.looper.openTemplateEditor(t.id)}
            onReorder={(ids) => void window.looper.templates.reorder(ids)}
          />
          <ListActions
            onAdd={() => void window.looper.openTemplateEditor()}
            onEdit={() => tpl && void window.looper.openTemplateEditor(tpl.id)}
            editDisabled={!tpl}
            onDuplicate={() => void duplicate()}
            duplicateDisabled={!tpl}
            onRemove={() => void remove()}
            removeDisabled={!tpl}
          />
          <div className="env-actions">
            <button className="btn" onClick={() => void window.looper.templates.import()}>
              Import…
            </button>
            <button className="btn" disabled={!tpl} onClick={() => tpl && void window.looper.templates.export(tpl.id)}>
              Export…
            </button>
          </div>
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
