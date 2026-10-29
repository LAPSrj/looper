import { useState } from 'react';
import type { Project } from '@shared/types';
import { useListNav } from './hooks';

/** The Projects pane's body: the projects in the user's order, dragged to reorder. */
export function ProjectList({
  projects,
  selected,
  compact,
  onSelect,
}: {
  projects: Project[];
  selected: string | null;
  compact: boolean;
  onSelect: (id: string) => void;
}) {
  // The dragged project, and the row it would go before (null = the end).
  const [drag, setDrag] = useState<{ id: string; before: string | null } | null>(null);
  const index = selected === null ? -1 : projects.findIndex((p) => p.id === selected);
  const rowId = (id: string) => `project-${id}`;
  const nav = useListNav({
    count: projects.length,
    index,
    onIndex: (i) => onSelect(projects[i].id),
    onActivate: (i) => void window.looper.projects.openEditor(projects[i].id),
    scrollToId: index >= 0 ? rowId(projects[index].id) : null,
  });

  if (!projects.length) {
    return (
      <div
        className="addon-pane-note muted"
        onContextMenu={(e) => {
          e.preventDefault();
          window.looper.projects.showContextMenu('');
        }}
      >
        No projects yet.
      </div>
    );
  }

  const drop = () => {
    if (!drag) return;
    const rest = projects.map((p) => p.id).filter((id) => id !== drag.id);
    const at = drag.before === null ? rest.length : rest.indexOf(drag.before);
    rest.splice(at < 0 ? rest.length : at, 0, drag.id);
    setDrag(null);
    void window.looper.projects.reorder(rest);
  };

  return (
    <ul
      className={`task-list${compact ? ' compact' : ''}`}
      role="listbox"
      aria-label="Projects"
      tabIndex={0}
      onKeyDown={nav}
      aria-activedescendant={index >= 0 ? rowId(projects[index].id) : undefined}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        // Below the last row: the end of the list.
        if (e.target === e.currentTarget && drag.before !== null) setDrag({ ...drag, before: null });
      }}
      onDrop={(e) => {
        e.preventDefault();
        drop();
      }}
    >
      {projects.map((p) => (
        <li
          key={p.id}
          id={rowId(p.id)}
          role="option"
          aria-selected={p.id === selected}
          className={`task-item${p.id === selected ? ' selected' : ''}${
            drag && drag.id !== p.id && drag.before === p.id ? ' drop-before' : ''
          }${drag && drag.id !== p.id && drag.before === null && p === projects[projects.length - 1] ? ' drop-after' : ''}`}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            setDrag({ id: p.id, before: null });
          }}
          onDragOver={(e) => {
            if (!drag) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            const after = e.clientY > rect.top + rect.height / 2;
            const i = projects.indexOf(p);
            const before = after ? (projects[i + 1]?.id ?? null) : p.id;
            if (before !== drag.before) setDrag({ ...drag, before });
          }}
          onDragEnd={() => setDrag(null)}
          onClick={() => onSelect(p.id)}
          onDoubleClick={() => void window.looper.projects.openEditor(p.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onSelect(p.id);
            window.looper.projects.showContextMenu(p.id);
          }}
        >
          <div className="task-item-row">
            <span className="task-name">{p.name}</span>
          </div>
          {!compact && (
            <div className="task-item-sub mono" title={p.cwd}>
              {p.cwd}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
