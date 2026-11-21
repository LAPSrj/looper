import { useEffect, useState } from 'react';
import type { Task } from '@shared/types';
import { SelectList, ListActions, ListButton } from './components/SelectList';
import { WindowActions } from './components/WindowActions';
import { rid } from '@shared/rid';
import { blankDraft } from './components/blank-draft';
import { subscribe } from './events';
import { keptSelection } from './components/selection';
import { reportError } from './report-error';

/** Standalone template manager window (Tools → Templates). All actions apply immediately. */
export function TemplatesApp() {
  const [templates, setTemplates] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Templates';
    const apply = (list: Task[]) => {
      setTemplates(list);
      setSelected((s) => keptSelection(s, list, (t) => t.id));
    };
    void window.looper.templates.list().then(apply);
    return subscribe((e) => {
      if (e.type === 'templates') apply(e.templates);
    });
  }, []);

  const tpl = templates.find((t) => t.id === selected);

  // Each command takes the template it acts on (the selected one for a button, the clicked row for the menu).
  // The template exists from the click, so its editor can open on it; closing the editor without Create deletes it.
  const add = async () => {
    try {
      const { settings } = await window.looper.info();
      const created = await window.looper.templates.save({ ...blankDraft(settings.defaultEnvironmentId), id: `tpl-${rid()}`, name: 'New template' });
      setSelected(created.id);
      void window.looper.openTemplateEditor(created.id, true);
    } catch (e) {
      reportError(e);
    }
  };

  const duplicate = async (from: Task | undefined = tpl) => {
    if (!from) return;
    const copy = {
      ...JSON.parse(JSON.stringify(from)),
      id: `${from.id}-${rid()}`,
      name: `${from.name} (copy)`,
    };
    delete copy.createdAt;
    delete copy.updatedAt;
    try {
      await window.looper.templates.save(copy);
      setSelected(copy.id);
    } catch (e) {
      reportError(e);
    }
  };

  const remove = async (target: Task | undefined = tpl) => {
    if (!target) return;
    if (!(await window.looper.confirm(`Remove template "${target.name}"?`))) return;
    try {
      await window.looper.templates.remove(target.id);
    } catch (e) {
      reportError(e);
    }
  };

  /** The order is the keyboard's too, where a drag isn't: one place up or down. */
  const move = (t: Task, by: -1 | 1) => {
    const ids = templates.map((x) => x.id);
    const at = ids.indexOf(t.id);
    if (at + by < 0 || at + by >= ids.length) return;
    ids.splice(at + by, 0, ...ids.splice(at, 1));
    void window.looper.templates.reorder(ids);
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
            autoFocus
            menu={(t, i) => [
              { label: 'Edit…', run: () => void window.looper.openTemplateEditor(t.id) },
              { label: 'Duplicate', run: () => void duplicate(t) },
              { label: 'Export…', run: () => void window.looper.templates.export(t.id) },
              { label: 'Move Up', enabled: i > 0, run: () => move(t, -1) },
              { label: 'Move Down', enabled: i < templates.length - 1, run: () => move(t, 1) },
              { label: 'Remove', destructive: true, run: () => void remove(t) },
            ]}
            onDelete={(t) => void remove(t)}
          />
          <ListActions
            item="Template"
            onAdd={() => void add()}
            onEdit={() => tpl && void window.looper.openTemplateEditor(tpl.id)}
            editDisabled={!tpl}
            onDuplicate={() => void duplicate()}
            duplicateDisabled={!tpl}
            onRemove={() => void remove()}
            removeDisabled={!tpl}
          >
            <ListButton onClick={() => void window.looper.templates.import()}>Import…</ListButton>
            <ListButton row disabled={!tpl} onClick={() => tpl && void window.looper.templates.export(tpl.id)}>
              Export…
            </ListButton>
          </ListActions>
        </div>
      </div>
      <WindowActions close />
    </div>
  );
}
