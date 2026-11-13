// Relative imports only: the main process, the renderer and the unit tests all load the list.
import type { UsageRing } from '../sessions';
import type { UiPlatform } from '../ui-platform';
import type { CommandContext } from './context';

/**
 * What a command is about. A screen or window shows a few views at once (the
 * desktop's Tasks tab shows `tasks`, `task` and `project`, a phone's task
 * screen `task`), and every surface is built from the commands of those views.
 * The `addon` views are an addon's own: its panes tab, the pane item picked,
 * and the screen showing (CommandContext `addon` says whose).
 */
export const COMMAND_VIEWS = [
  'new',
  'frame',
  'app',
  'dashboard',
  'tasks',
  'task',
  'projects',
  'project',
  'chats',
  'conversation',
  'chatWindow',
  'history',
  'historyItem',
  'run',
  'engineLog',
  'addonPanes',
  'addonItem',
  'addonScreen',
] as const;
export type CommandView = (typeof COMMAND_VIEWS)[number];

/** The views no phone screen shows: a menu item only here goes to the More view, after the addons' rows. */
export const DESKTOP_VIEWS: readonly CommandView[] = ['new', 'frame', 'app', 'chatWindow'];

/** The menu bar, in its order. */
export const MENU_BAR = [
  { name: 'file', label: '&File' },
  { name: 'edit', label: '&Edit' },
  { name: 'view', label: '&View' },
  { name: 'task', label: '&Task' },
  { name: 'project', label: '&Project' },
  { name: 'chat', label: '&Chat' },
  { name: 'tools', label: 'T&ools' },
  { name: 'advanced', label: '&Advanced' },
  { name: 'window', label: '&Window' },
  { name: 'help', label: '&Help' },
] as const;
export type MenuName = (typeof MENU_BAR)[number]['name'];

interface Placement {
  /** Shows on a phone's bar while it can run and fits there, in the list's order. */
  main?: true;
  /** Left out of the view's right-click menu. */
  context?: false;
  /** A chat's message box draws it, so a phone's bar and More leave it out there. */
  box?: true;
}

/** Where a command shows in one view: in a menu, on the toolbar, or both. */
export type Where = Placement &
  ({ menu: MenuName; toolbar?: true } | { menu?: undefined; toolbar: true } | { menu?: undefined; toolbar?: undefined; main: true } | { menu?: undefined; toolbar?: undefined; box: true });

/** Leaving a command out, of any platform, view or state, always says why. */
export type Hide = { why: string; view?: CommandView; surface?: 'menu' | 'toolbar' } & ({ on: readonly UiPlatform[]; if?: (c: CommandContext) => boolean } | { on?: undefined; if: (c: CommandContext) => boolean });

/** One choice of a command's submenu. */
export type Entry =
  | { separator: true }
  | {
      id: string;
      label: string;
      icon?: string;
      /** A check mark: `radio` for a choice of one. */
      checked?: boolean;
      radio?: true;
      enabled?: boolean;
      destructive?: true;
      accelerator?: string;
      pageKey?: true;
      entries?: Entry[];
      run?: () => void;
    };

export type LabelOf = string | ((c: CommandContext) => string);

export interface Command {
  /** The item's id on every surface; a click on the native menu comes back as this. */
  id: string;
  /** With its & mnemonic; a toolbar and a phone drop it, and a trailing "…". */
  label: LabelOf;
  /** A label that names what it acts on, on a toolbar or a phone's bar. */
  toolbarLabel?: LabelOf;
  /** A separator falls between two groups, on every surface. */
  group: string;
  /** On a toolbar, the group next to it instead: a toolbar keeps few separators. */
  toolbarGroup?: string;
  /** On a toolbar, last in its group, wherever the menus list it. */
  toolbarLast?: true;
  /** What iconNode draws (renderer components/icons.tsx): an ICONS key, or an addon's drawing. */
  icon?: string | ((c: CommandContext) => string | undefined);
  /** No glyph in a menu: only the toolbar shows the icon. */
  menuGlyph?: false;
  /** On a toolbar, its label beside the icon: for a command people don't know by its icon. */
  labeled?: true;
  accelerator?: string | ((c: CommandContext) => string | undefined);
  /** The page handles the key itself (a terminal keeps it), so the menu only shows it. */
  pageKey?: true | ((c: CommandContext) => boolean);
  /** It destroys or cuts something off: a phone draws it red and last. */
  destructive?: true;
  /** A two-state command's other state. */
  alt?: { label: string; icon?: string; when: (c: CommandContext) => boolean };
  /** Default true. */
  enabled?: (c: CommandContext) => boolean;
  /** A check box in a menu, a pressed button on a toolbar. */
  checked?: (c: CommandContext) => boolean;
  /** A radio item, in a group of them. */
  radio?: true;
  /** A submenu, or with `run` a split button's drop-down. */
  entries?: (c: CommandContext) => Entry[];
  /** A split button's `run` has something to act on: without it the button opens its drop-down. */
  runnable?: (c: CommandContext) => boolean;
  /** With `entries`: the choices show in place, without a submenu. */
  inline?: true;
  /** The drop-down arrow's tooltip on a split button. */
  dropdown?: LabelOf;
  /** A split button whose drop-down only the main process can fill (recent conversations). */
  openDropdown?: (c: CommandContext, x: number, y: number) => void;
  /** A face that isn't an icon (the usage ring). */
  ring?: (c: CommandContext) => UsageRing;
  /** A menu role the system carries out (Copy, Paste, Exit). */
  role?: string;
  /** Its items are what only the main process knows, which it fills in as it draws the menu. */
  provided?: 'open-windows' | 'always-on-top';
  /** Tinted on a phone's bar: what it controls isn't at its default. */
  on?: (c: CommandContext) => boolean;
  run?: (c: CommandContext) => void;
  hide?: readonly Hide[];
  in: Partial<Record<CommandView, Where>>;
}

/** The label for this state. */
export function labelOf(cmd: Command, c: CommandContext): string {
  if (cmd.alt?.when(c)) return cmd.alt.label;
  return typeof cmd.label === 'function' ? cmd.label(c) : cmd.label;
}

/** The icon for this state. */
export const iconOf = (cmd: Command, c: CommandContext): string | undefined => (cmd.alt?.when(c) && cmd.alt.icon) || (typeof cmd.icon === 'function' ? cmd.icon(c) : cmd.icon);

/** A menu label without its mnemonic. */
export const noMnemonic = (label: string): string => label.replace(/&(&?)/g, '$1');

/** A menu label as a toolbar or a phone writes it: no & mnemonic, no "…". */
export const plainLabel = (label: string): string => noMnemonic(label).replace(/…$/, '');

/** A project or folder name in a menu label: its & is a letter. */
export const menuText = (name: string): string => name.replace(/&/g, '&&');
