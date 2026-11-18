import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Chevron } from '../components/icons';
import { Menu } from '../components/Menu';
import { platform } from '../platform';
import type { HostBrowser } from './file-flows';
import { CHEVRON_DOWN } from './NavBarRow';

const ARROW_RIGHT = (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" fill="currentColor" />
  </svg>
);

/**
 * Where a file browser is, as each OS shows it, each part going to its folder.
 * Windows: the address bar's breadcrumb buttons, chevrons between them.
 * Android: the folders in a row with arrows between them, scrolled to the
 * current one. iOS: the folder's name as the bar's title, which opens a menu
 * of the folders above it, nearest first.
 */
export function PathBar({ browser }: { browser: HostBrowser }) {
  if (platform === 'ios') return <TitleMenu browser={browser} />;
  if (platform === 'android') return <Crumbs browser={browser} />;
  return <Breadcrumbs browser={browser} />;
}

function Breadcrumbs({ browser }: { browser: HostBrowser }) {
  return (
    <nav className="ws-crumbs" aria-label="Path">
      {browser.crumbs.map((c, i) => (
        <span key={c.path ?? ''} className="ws-crumb-part">
          {i > 0 && (
            <span className="ws-crumb-sep">
              <Chevron />
            </span>
          )}
          <button className="ws-crumb" onClick={() => browser.go(c.path)}>
            {c.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

function Crumbs({ browser }: { browser: HostBrowser }) {
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    row.current?.scrollTo({ left: row.current.scrollWidth });
  }, [browser.path]);
  return (
    <div ref={row} className="md-crumbs ph-scroll">
      {browser.crumbs.map((c, i) => (
        <span key={c.path ?? ''} className="md-crumb-part">
          {i > 0 && <span className="md-crumb-sep">{ARROW_RIGHT}</span>}
          <button className={`md-crumb${i === browser.crumbs.length - 1 ? ' current' : ''}`} onClick={() => browser.go(c.path)}>
            {c.label}
          </button>
        </span>
      ))}
    </div>
  );
}

function TitleMenu({ browser }: { browser: HostBrowser }) {
  /** The open menu: the title's place, and the frame's root it's drawn in (out of the sheet, which moves). */
  const [open, setOpen] = useState<{ rect: DOMRect; root: Element } | null>(null);
  const crumbs = browser.crumbs;
  const above = crumbs.slice(0, -1).reverse();
  const menu = above.length > 0;
  return (
    <>
      <button
        className="ios-bar-title ios-title-menu"
        aria-haspopup={menu ? 'menu' : undefined}
        disabled={!menu}
        onClick={(e) => {
          const root = e.currentTarget.closest('.ph-root');
          if (root) setOpen({ rect: e.currentTarget.getBoundingClientRect(), root });
        }}
      >
        <span className="ios-title-menu-label">{crumbs[crumbs.length - 1].label}</span>
        {menu && <span className="ios-title-menu-chevron">{CHEVRON_DOWN}</span>}
      </button>
      {open &&
        createPortal(
          <Menu
            items={above.map((c, i) => ({ id: String(i), type: 'normal', label: c.label, enabled: true, icon: 'openFolder' }))}
            place={{ kind: 'control', rect: open.rect, align: 'center' }}
            onClose={() => setOpen(null)}
            onPick={(it) => browser.go(above[Number(it.id)].path)}
          />,
          open.root,
        )}
    </>
  );
}
