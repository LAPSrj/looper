import { Icon } from './Icon';

/** The arrow of a button that opens a menu beside its command (a split button's half). */
export const MENU_ARROW = (
  <svg width="8" height="16" viewBox="0 0 8 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m1.5 6.8 2.5 2.5 2.5-2.5" />
  </svg>
);

/**
 * An icon button of a toolbar, with its tooltip; `pressed` makes it a toggle.
 * `labeled` shows the title beside the icon instead of as a tooltip.
 */
export function ToolButton({
  icon,
  title,
  enabled,
  onClick,
  pressed,
  labeled,
}: {
  icon?: React.ReactNode;
  title: string;
  enabled: boolean;
  onClick: () => void;
  pressed?: boolean;
  labeled?: boolean;
}) {
  const className = [labeled ? 'labeled' : '', pressed ? 'pressed' : ''].filter(Boolean).join(' ') || undefined;
  return (
    <button
      title={labeled ? undefined : title}
      aria-label={labeled ? undefined : title}
      disabled={!enabled}
      onClick={onClick}
      className={className}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
    >
      {icon && <Icon>{icon}</Icon>}
      {labeled && title}
    </button>
  );
}

/**
 * A toolbar split button: the icon does the command in the current place, the
 * arrow beside it opens a list of places. With no current place, the icon
 * opens the list too. `onMenu` gets where the list goes, under the button.
 */
export function SplitToolButton({
  icon,
  title,
  menuTitle,
  enabled,
  onClick,
  onMenu,
}: {
  icon: React.ReactNode;
  title: string;
  menuTitle: string;
  enabled: boolean;
  /** Null: there's no current place, so the icon opens the list. */
  onClick: (() => void) | null;
  onMenu: (x: number, y: number) => void;
}) {
  const menuAt = (el: HTMLElement) => {
    const box = (el.closest('.split-button') ?? el).getBoundingClientRect();
    onMenu(box.left, box.bottom);
  };
  return (
    <span className="split-button">
      <button title={title} aria-label={title} disabled={!enabled} onClick={(e) => (onClick ? onClick() : menuAt(e.currentTarget))}>
        <Icon>{icon}</Icon>
      </button>
      <button className="split-arrow" title={menuTitle} aria-label={menuTitle} aria-haspopup="menu" disabled={!enabled} onClick={(e) => menuAt(e.currentTarget)}>
        {MENU_ARROW}
      </button>
    </span>
  );
}
