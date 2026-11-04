// Relative imports only: the main process, the renderer and the unit tests all load the catalogs.
import type { UiPlatform } from '../ui-platform';

/**
 * Where a command shows on a phone. `group`: its group in the More menu of
 * the screens that list its catalog (the catalog names its groups in order;
 * within a group, catalog order), on the session kinds in `kinds` (unset:
 * every kind). `hidden`: it doesn't show on a phone, and the reason says why.
 */
export type MobilePlacement<G extends string = string, K extends string = string> = { group: G; kinds?: readonly K[] } | { hidden: string };

/**
 * One command of a window, defined once: the menu bar's item, the toolbar's
 * button and the phone's More menu are built from it. The builders add what
 * changes with the state (enabled, what it does, which of two labels).
 */
export interface Command<M extends string = string, T extends string = string, G extends string = string, K extends string = string> {
  /** The menu label, with its & mnemonic. The toolbar's is the same without the & and a trailing "…". */
  label: string;
  /** A command with two states (Pause and Resume): the label, and icon, while the binding's `alt` is true. */
  alt?: { label: string; icon?: string };
  /** An ICONS key: the menu's glyph and the toolbar's icon. */
  icon?: string;
  /** The menu accelerator; the toolbar's tooltip shows it as a hint. */
  accelerator?: string;
  /** The page handles the key itself (a terminal keeps it), so the menu doesn't register it. */
  pageKey?: true;
  /** It destroys or cuts something off (Delete, Stop, Close): its menu item and toolbar button carry the mark. */
  destructive?: true;
  platforms?: UiPlatform[];
  /**
   * Its menu item: the item's id, the menu it's in, and its group there (a
   * separator falls between two groups). `glyph: false`: the menu item shows
   * no glyph, only the toolbar shows the icon.
   */
  menu?: { id: string; in: M; group: string; glyph?: false };
  /** Its toolbar button: the item's id and the toolbar group it's in. */
  toolbar?: { id: string; group: T };
  mobile: MobilePlacement<G, K>;
}

/** A window's commands, by name. */
export type Catalog = Record<string, Command>;

/** The catalog's commands in menu `M`. */
export type MenuKeys<C, M extends string> = { [K in keyof C]: C[K] extends { menu: { in: M } } ? K : never }[keyof C];
/** The catalog's commands in toolbar group `G`. */
export type ToolbarKeys<C, G extends string> = { [K in keyof C]: C[K] extends { toolbar: { group: G } } ? K : never }[keyof C];

/** The label for the state the binding gives. */
export const commandLabel = (c: Command, alt?: boolean): string => (alt && c.alt ? c.alt.label : c.label);
/** The icon for the state the binding gives. */
export const commandIcon = (c: Command, alt?: boolean): string | undefined => (alt && c.alt?.icon) || c.icon;
/** A menu label as a toolbar or a phone writes it: no & mnemonic, no "…". */
export const plainLabel = (label: string): string => label.replace(/&(&?)/g, '$1').replace(/…$/, '');
