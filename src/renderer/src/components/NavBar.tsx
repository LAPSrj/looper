import { createContext, useContext, useMemo, useState } from 'react';
import { platform } from '../platform';
import { barModel, dismissFor } from '../web/nav-bar-model';
import type { Presentation } from '../web/nav-stack';
import { IosBarRow, MdBarRow } from '../web/NavBarRow';
import { panelNavTarget, usePageNav, type NavTarget, type PageNav } from '../web/page-nav';

/**
 * A sheet or dialog that draws its own bar (a page's PhoneSheet, the frames'
 * own sheets): NavBar draws the bar in place, and closing it is the host's.
 */
export interface BarHost {
  presentation: Presentation;
  close: () => void;
}

export const BarHostContext = createContext<BarHost | null>(null);

/** A panel that draws its own bar (PhoneSheet, the iPad's inspector column): the NavBars inside it report to it, not to the frame. */
export const PanelNavContext = createContext<NavTarget | null>(null);

/**
 * A screen inside the panel pushed a detail, whose Back is in the panel's bar: the panel's own tabs give way to it, as
 * a pushed screen's bar replaces the list's (HIG Sheets; Material 3 list-detail: a single pane shows the detail).
 */
export const PanelPushedContext = createContext(false);

/** A panel's bar: what the NavBars inside its PanelNavContext (`target`) report, merged; null while none does. */
export function usePanelNav(): { nav: PageNav | null; target: NavTarget } {
  const [nav, setNav] = useState<PageNav | null>(null);
  const target = useMemo(() => panelNavTarget(setNav), []);
  return { nav, target };
}

export type NavBarProps = PageNav & {
  /** Where this part goes among the page's other NavBars: a higher order overrides a lower one's fields and adds its toolbar after. */
  order?: number;
};

/**
 * A screen's navigation bar: its title, Back, an editor's Cancel and Confirm,
 * its bar buttons, toolbar and More menu. The desktop draws nothing (its
 * window has a title bar, a toolbar and a footer); a phone draws the bar of
 * its platform, with the buttons placed by the one set of rules in
 * nav-bar-model.ts. Inside a BarHost it's drawn in place; inside a panel with
 * a bar of its own, that panel draws it; anywhere else the phone frame draws it
 * over the window.
 */
export function NavBar(props: NavBarProps) {
  const host = useContext(BarHostContext);
  const panel = useContext(PanelNavContext);
  return host ? <HostedBar host={host} nav={props} /> : <ReportedBar nav={props} target={panel ?? undefined} />;
}

function ReportedBar({ nav: { order = 0, ...nav }, target }: { nav: NavBarProps; target?: NavTarget }) {
  usePageNav(platform === 'ios' ? nav : withoutLargeTitle(nav), order, target);
  return null;
}

/** A large title is iOS's: elsewhere the bar shows the title from the start, so a screen asks for one everywhere. */
const withoutLargeTitle = (nav: PageNav): PageNav => ({
  ...nav,
  largeTitle: nav.largeTitle && false,
  split: nav.split && { ...nav.split, largeTitle: nav.split.largeTitle && false },
});

function HostedBar({ host, nav }: { host: BarHost; nav: PageNav }) {
  const model = barModel({
    title: nav.title ?? '',
    subtitle: nav.subtitle,
    back: nav.back,
    cancel: nav.cancel,
    confirm: nav.confirm,
    actions: nav.actions,
    dismiss: dismissFor(host.presentation, { back: host.close, close: host.close }),
  });
  if (platform === 'android') return <MdBarRow model={model} dialogLike={host.presentation === 'full-dialog' || host.presentation === 'dialog'} />;
  return <IosBarRow model={model} />;
}
