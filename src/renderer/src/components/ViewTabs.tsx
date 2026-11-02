import type { MainTabDef } from '@shared/main-tabs';
import type { View } from '@shared/types';
import { Icon } from './Icon';
import { ICONS } from './icons';
import { tabStop } from './tabs-model';

type TabsView = View['tabs'];

/** The key that moves to the next (1) or previous (-1) tab, along the strip's direction. */
const STEPS: Record<'horizontal' | 'vertical', Record<string, 1 | -1>> = {
  horizontal: { ArrowRight: 1, ArrowLeft: -1 },
  vertical: { ArrowDown: 1, ArrowUp: -1 },
};

/**
 * The main window's tabs: one per view (Dashboard, Projects, Tasks, Chats,
 * then the addons'), in a row below the toolbar or above the status bar, or in
 * a column down the window's left side. A row shows each tab's name, after its
 * icon unless View → Tabs → Icons is off; the column shows each icon, above its
 * name unless View → Tabs → Labels is off. They look unlike the tab rows
 * inside a view, which pick a part of the view rather than the view.
 */
export function ViewTabs({ tabs, active, onSelect, layout }: { tabs: MainTabDef[]; active: string; onSelect: (id: string) => void; layout: TabsView }) {
  const vertical = layout.position === 'left';
  const showIcon = vertical || layout.icons;
  const showLabel = !vertical || layout.labels;
  const ids = tabs.map((t) => t.id);
  const stop = tabStop(ids, active);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.altKey || e.metaKey || ids.length === 0) return;
    const at = Math.max(0, ids.indexOf(active));
    const step = STEPS[vertical ? 'vertical' : 'horizontal'][e.key];
    const to = step ? ids[(at + step + ids.length) % ids.length] : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[ids.length - 1] : null;
    if (!to) return;
    e.preventDefault();
    onSelect(to);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[ids.indexOf(to)]?.focus();
  };

  return (
    <div
      className={`view-tabs ${layout.position}${showLabel ? '' : ' icons-only'}`}
      role="tablist"
      aria-label="Views"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      onKeyDown={onKeyDown}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          tabIndex={t.id === stop ? 0 : -1}
          className={`view-tab${t.id === active ? ' active' : ''}`}
          // An icon alone needs its name on hover.
          title={showLabel ? undefined : t.label}
          aria-label={showLabel ? undefined : t.label}
          onClick={() => onSelect(t.id)}
        >
          {showIcon && <Icon>{(ICONS as Record<string, React.ReactNode>)[t.icon] ?? ICONS.window}</Icon>}
          {showLabel && <span className="view-tab-label">{t.label}</span>}
        </button>
      ))}
    </div>
  );
}
