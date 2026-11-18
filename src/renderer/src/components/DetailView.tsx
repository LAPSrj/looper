import type { ReactNode } from 'react';
import { PropertyList, type Property } from './PropertyList';
import { TabBar } from './ui';

/**
 * What the main window shows beside its list (a task, a project, the
 * Dashboard, an addon's screen): its name in a bar, then its tabs and the
 * shown tab's body, or its body alone. `untitled`: an item's own window,
 * whose title bar already names it.
 */
export function DetailView<T extends string>({
  title,
  untitled = false,
  className = 'detail',
  tabs,
  children,
}: {
  title: ReactNode;
  untitled?: boolean;
  className?: string;
  tabs?: { items: readonly (readonly [T, string])[]; active: T; onSelect: (id: T) => void };
  children: ReactNode;
}) {
  return (
    <div className={className}>
      {!untitled && (
        <div className="detail-bar">
          <span className="pane-title">{title}</span>
        </div>
      )}
      {tabs ? (
        <>
          <TabBar tabs={tabs.items} active={tabs.active} onSelect={tabs.onSelect} />
          <section className="tab-body">{children}</section>
        </>
      ) : (
        children
      )}
    </div>
  );
}

/** A detail's Status tab: its facts. */
export function DetailStatus({ items }: { items: (Property | false | null | undefined)[] }) {
  return (
    <div className="status-pane">
      <PropertyList items={items} />
    </div>
  );
}
