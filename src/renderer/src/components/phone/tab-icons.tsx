import { Icon } from '../Icon';
import { ICONS } from '../icons';

/** The desktop's tab icons, which a phone's tab bar and rail draw in place of the systems' own symbols (Leandro's choice). */
const DESKTOP_TABS: Record<string, keyof typeof ICONS> = { dashboard: 'dashboardTab', projects: 'projectsTab', tasks: 'tasksTab', sessions: 'chatsTab' };

/** More's three dots on a 24-point grid, which iOS fills (phone.css `.fill`): the desktop has no More tab to take an icon from. */
const MORE = (
  <>
    <circle className="fill" cx="5.5" cy="12" r="1.2" />
    <circle className="fill" cx="12" cy="12" r="1.2" />
    <circle className="fill" cx="18.5" cy="12" r="1.2" />
  </>
);

/** A view's 24 px icon: the desktop's own tab icon, scaled, or More's dots. */
export function TabIcon({ id }: { id: string }) {
  const desktop = DESKTOP_TABS[id];
  if (desktop) return <Icon name={desktop} size={24} className="desktop-tab-icon" />;
  return (
    <Icon size={24} box={24} stroke={1.6}>
      {MORE}
    </Icon>
  );
}
