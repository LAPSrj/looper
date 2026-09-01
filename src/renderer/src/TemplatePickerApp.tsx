import { useEffect, useRef, useState } from 'react';
import type { Environment, Task } from '@shared/types';

export function TemplatePickerApp() {
  const [templates, setTemplates] = useState<Task[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    document.title = 'New Task from Template';
    void window.looper.info().then((info) => {
      setEnvironments(info.settings.environments);
    });
    void window.looper.templates.list().then((t) => {
      setTemplates(t);
      if (t.length > 0) setSelected(t[0].id);
    });
    return window.looper.onEvent((e) => {
      if (e.type === 'templates') {
        setTemplates(e.templates);
        setSelected((s) => (s && e.templates.some((t) => t.id === s) ? s : e.templates[0]?.id ?? null));
      } else if (e.type === 'settings') {
        setEnvironments(e.settings.environments);
      }
    });
  }, []);

  const create = () => {
    const sel = selectedRef.current;
    if (!sel) return;
    void window.looper.openEditorFromTemplate(sel);
    window.close();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        window.close();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        create();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onListKey = (e: React.KeyboardEvent) => {
    if (!templates.length) return;
    const idx = selected ? templates.findIndex((t) => t.id === selected) : -1;
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = idx < 0 ? 0 : Math.min(templates.length - 1, idx + 1);
        break;
      case 'ArrowUp':
        next = idx < 0 ? 0 : Math.max(0, idx - 1);
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = templates.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    setSelected(templates[next].id);
  };

  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? id;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="picker-body">
          <div className="field">
            <label className="field-label">Template</label>
            {templates.length === 0 ? (
              <div className="empty">No templates. Create one in Settings.</div>
            ) : (
              <ul
                className="env-list boxed"
                role="listbox"
                aria-label="Templates"
                tabIndex={0}
                onKeyDown={onListKey}
                aria-activedescendant={selected ? `tpl-${selected}` : undefined}
              >
                {templates.map((t) => (
                  <li
                    key={t.id}
                    id={`tpl-${t.id}`}
                    role="option"
                    aria-selected={t.id === selected}
                    className={`env-item ${t.id === selected ? 'selected' : ''}`}
                    onClick={() => setSelected(t.id)}
                    onDoubleClick={create}
                  >
                    <div className="env-item-name">{t.name}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      <div className="editor-footer">
        <button className="btn primary" onClick={create} disabled={!selected}>
          Create
        </button>
        <button className="btn" onClick={() => window.close()}>
          Cancel
        </button>
      </div>
    </div>
  );
}
