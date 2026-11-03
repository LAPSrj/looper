import type { MainTabDef } from '@shared/main-tabs';
import type { View } from '@shared/types';
import { Icon } from './Icon';
import { ICONS } from './icons';
import { Tabs } from './Tabs';
import { tabStop } from './tabs-model';

type TabsView = View['tabs'];

const iconOf = (t: MainTabDef) => <Icon>{(ICONS as Record<string, React.ReactNode>)[t.icon] ?? ICONS.window}</Icon>;

/**
 * The main window's tabs: one per view (Dashboard, Projects, Tasks, Chats,
 * then the addons'). Below the toolbar or above the status bar they are the
 * shared Tabs strip, each name after its icon unless View → Tabs → Icons is
 * off. Down the window's left side they are a column of icons, each above its
 * name unless View → Tabs → Labels is off.
 */
export function ViewTabs({ tabs, active, onSelect, layout }: { tabs: MainTabDef[]; active: string; onSelect: (id: string) => void; layout: TabsView }) {
  if (layout.position !== 'left') {
    return (
      <Tabs
        tabs={tabs.map((t) => ({ id: t.id, label: t.label, icon: layout.icons ? iconOf(t) : undefined }))}
        active={active}
        onSelect={onSelect}
        label="Views"
        className={`main-tabs ${layout.position}`}
        panelAbove={layout.position === 'bottom'}
      />
    );
  }
  return <TabRail tabs={tabs} active={active} onSelect={onSelect} labels={layout.labels} />;
}

function TabRail({ tabs, active, onSelect, labels }: { tabs: MainTabDef[]; active: string; onSelect: (id: string) => void; labels: boolean }) {
  const ids = tabs.map((t) => t.id);
  const stop = tabStop(ids, active);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey || ids.length === 0) return;
    const at = Math.max(0, ids.indexOf(active));
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    const to = step ? ids[(at + step + ids.length) % ids.length] : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[ids.length - 1] : null;
    if (!to) return;
    e.preventDefault();
    onSelect(to);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[ids.indexOf(to)]?.focus();
  };

  return (
    <div className={`view-tabs${labels ? '' : ' icons-only'}`} role="tablist" aria-label="Views" aria-orientation="vertical" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          tabIndex={t.id === stop ? 0 : -1}
          className={`view-tab${t.id === active ? ' active' : ''}`}
          // An icon alone needs its name on hover.
          title={labels ? undefined : t.label}
          aria-label={labels ? undefined : t.label}
          onClick={() => onSelect(t.id)}
        >
          {iconOf(t)}
          {labels && <span className="view-tab-label">{t.label}</span>}
        </button>
      ))}
    </div>
  );
}
