import type { View } from '@shared/types';
import { phoneTabForm, type PhoneTabForm } from '../phone-nav';
import { platform } from '../platform';
import { Icon } from './Icon';
import { ICONS, iconNode } from './icons';
import { NavBar } from './NavBar';
import { TabIcon } from './phone/tab-icons';
import { Tabs } from './Tabs';
import { tabKeyTarget, tabStop } from './tabs-model';

type TabsView = View['tabs'];

/** One of the main window's views: its id, its name, and the icon the desktop draws (an iconNode key). */
export interface ViewTab {
  id: string;
  label: string;
  icon?: string;
}

/**
 * Where the tabs go: on the desktop the View → Tabs choice (top, bottom or
 * left), on a phone or tablet the form its system gives them
 * (`phoneViewTabsForm`).
 */
export type ViewTabsLayout = TabsView | PhoneTabForm;

/** The form the main window's tabs take on this phone or tablet, `width` px wide, `split` when it shows a list beside its screen. */
export const phoneViewTabsForm = (width: number, split: boolean): PhoneTabForm => phoneTabForm(platform === 'android' ? 'android' : 'ios', width, split);

const iconOf = (t: ViewTab) => <Icon>{iconNode(t.icon ?? '') ?? ICONS.window}</Icon>;

/**
 * The main window's view switcher, one per window on every device: one tab
 * per view (Dashboard, Projects, Tasks, Chats, then the addons' on the
 * desktop, More on a phone).
 *
 * - Desktop, below the toolbar or above the status bar: the shared Tabs strip,
 *   each name after its icon unless View → Tabs → Icons is off. Down the
 *   window's left side: a column of icons, each above its name unless View →
 *   Tabs → Labels is off.
 * - Phone: the tab bar at the bottom; an Android tablet's rail beside the
 *   content.
 * - iPad: the tabs go to the frame (NavBar), which draws iPadOS's tab bar near
 *   the top of the screen.
 */
export function ViewTabs({ tabs, active, onSelect, layout }: { tabs: readonly ViewTab[]; active: string; onSelect: (id: string) => void; layout: ViewTabsLayout }) {
  if (layout === 'top') return <NavBar tabs={{ items: tabs.map((t) => [t.id, t.label] as const), value: active, select: onSelect }} />;
  if (layout === 'bar' || layout === 'rail') return <PhoneTabBar tabs={tabs} active={active} onSelect={onSelect} rail={layout === 'rail'} />;
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

function TabRail({ tabs, active, onSelect, labels }: { tabs: readonly ViewTab[]; active: string; onSelect: (id: string) => void; labels: boolean }) {
  const ids = tabs.map((t) => t.id);
  const stop = tabStop(ids, active);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const to = tabKeyTarget(ids, active, e, 'vertical');
    if (to === null) return;
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

/**
 * A phone's tab bar at the bottom (iOS's glass capsule, Material's navigation
 * bar), or an Android tablet's navigation rail beside the content. The bar
 * owns the bottom safe area, so the frame leaves it to the page.
 */
function PhoneTabBar({ tabs, active, onSelect, rail }: { tabs: readonly ViewTab[]; active: string; onSelect: (id: string) => void; rail: boolean }) {
  return (
    <>
      {!rail && <NavBar ownsBottom />}
      <nav className={`phone-tabbar${rail ? ' rail' : ''}`} aria-label="Looper">
        {tabs.map((t) => (
          <button key={t.id} className={`phone-tab${active === t.id ? ' active' : ''}`} aria-current={active === t.id ? 'page' : undefined} onClick={() => onSelect(t.id)}>
            <span className="phone-tab-icon">
              <TabIcon id={t.id} />
            </span>
            <span className="phone-tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
