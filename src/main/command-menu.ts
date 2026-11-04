import { commandIcon, commandLabel, type Catalog, type Command, type MenuKeys } from '../shared/commands/types';

type MenuItem = Electron.MenuItemConstructorOptions;

/** What a menu builder adds to a catalog command's item: what it does, and whether it can now. */
export interface MenuBinding {
  click?: MenuItem['click'];
  /** Default true. */
  enabled?: boolean;
  /** A two-state command's other state: its `alt` label and icon (Resume, Enable, Reopen, Edit Guidance). */
  alt?: boolean;
  /** A label that names something (the shown project), in place of the catalog's. */
  label?: string;
  /** A submenu built from state (Harness, Model, a list of projects). */
  submenu?: MenuItem[];
}

/** A catalog command's menu item: id, label, accelerator, glyph and platforms from the catalog, the rest from the binding. */
export function commandMenuItem(c: Command, b: MenuBinding): MenuItem {
  if (!c.menu) throw new Error(`${c.label} has no menu item.`);
  const glyph = c.menu.glyph === false ? undefined : commandIcon(c, b.alt);
  return {
    id: c.menu.id,
    label: b.label ?? commandLabel(c, b.alt),
    ...(c.accelerator ? { accelerator: c.accelerator } : {}),
    ...(c.pageKey ? { registerAccelerator: false } : {}),
    ...(glyph ? { glyph } : {}),
    ...(c.platforms ? { platforms: c.platforms } : {}),
    ...(c.destructive ? { destructive: true as const } : {}),
    ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
    ...(b.submenu ? { submenu: b.submenu } : {}),
    ...(b.click ? { click: b.click } : {}),
  };
}

/**
 * The catalog's commands in menu `menu`, in the order the bindings give them,
 * with a separator between two of the catalog's groups. Every command of the
 * menu needs a binding (the typecheck says which is missing); null leaves it
 * out of this window's menu.
 */
export function commandMenu<C extends Catalog, M extends string>(catalog: C, menu: M, bindings: { [K in MenuKeys<C, M>]: MenuBinding | null }): MenuItem[] {
  const out: MenuItem[] = [];
  let group: string | undefined;
  for (const [key, b] of Object.entries(bindings) as [string, MenuBinding | null][]) {
    const c = catalog[key];
    if (c?.menu?.in !== menu) throw new Error(`${key} isn't in the ${menu} menu.`);
    if (!b) continue;
    if (group !== undefined && c.menu.group !== group) out.push({ type: 'separator' });
    group = c.menu.group;
    out.push(commandMenuItem(c, b));
  }
  return out;
}
