import { createContext, useContext } from 'react';
import { platform } from '../platform';
import { barModel, dismissFor } from '../web/nav-bar-model';
import type { Presentation } from '../web/nav-stack';
import { IosBarRow, MdBarRow } from '../web/NavBarRow';
import { usePageNav, type PageNav } from '../web/page-nav';

/**
 * A sheet or dialog that draws its own bar (a page's PhoneSheet, the frames'
 * own sheets): NavBar draws the bar in place, and closing it is the host's.
 */
export interface BarHost {
  presentation: Presentation;
  close: () => void;
}

export const BarHostContext = createContext<BarHost | null>(null);

export type NavBarProps = PageNav & {
  /** Where this part goes among the page's other NavBars: a higher order overrides a lower one's fields and adds its toolbar after. */
  order?: number;
};

/**
 * A screen's navigation bar: its title, Back, an editor's Cancel and Confirm,
 * its bar buttons, toolbar and More menu. The desktop draws nothing (its
 * window has a title bar, a toolbar and a footer); a phone draws the bar of
 * its platform, with the buttons placed by the one set of rules in
 * nav-bar-model.ts. Inside a BarHost it's drawn in place; anywhere else the
 * phone frame draws it over the window.
 */
export function NavBar(props: NavBarProps) {
  const host = useContext(BarHostContext);
  return host ? <HostedBar host={host} nav={props} /> : <ReportedBar {...props} />;
}

function ReportedBar({ order = 0, ...nav }: NavBarProps) {
  usePageNav(platform === 'ios' ? nav : withoutLargeTitle(nav), order);
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
