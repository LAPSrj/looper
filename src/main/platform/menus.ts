import type { MenuItemSpec } from '../../shared/remote-access';
import { showsOn, type UiPlatform } from '../../shared/ui-platform';

/**
 * Looper's own fields on a menu template item. Electron keeps a template's
 * extra fields on the MenuItem it builds (checked live with Electron 45.2.1:
 * `Menu.buildFromTemplate([{ platforms: [...] }]).items[0].platforms` reads
 * them back), so they travel with the menu.
 */
declare global {
  namespace Electron {
    interface MenuItemConstructorOptions {
      /** Where the item shows; unset: everywhere (shared/ui-platform). */
      platforms?: UiPlatform[];
      /** An ICONS key (renderer components/icons.tsx) the phone's menus draw. Not `icon`, which Electron reads as an image. */
      glyph?: string;
    }
    interface MenuItem {
      platforms?: UiPlatform[];
      glyph?: string;
    }
  }
}

/** What an Electron MenuItem reads back as; plain objects of this shape stand in for one in tests. */
export interface MenuItemLike {
  id?: string;
  label?: string;
  type?: string;
  enabled?: boolean;
  checked?: boolean;
  visible?: boolean;
  accelerator?: string | null;
  registerAccelerator?: boolean;
  role?: string | null;
  submenu?: MenuLike | null;
  platforms?: UiPlatform[];
  glyph?: string;
  /** Electron's wrapper, click(event, window, webContents): it flips `checked` for checkbox and radio items, then calls the template's click(item, window, event). */
  click?: Function;
}

export interface MenuLike {
  items: MenuItemLike[];
}

/** The letter or digit an access key (`&X`) in the label makes, lower case; undefined for a label without one. */
function accessKeyOf(label: string): string | undefined {
  const m = /&(?!&)(.)/u.exec(label.replace(/&&/g, ''));
  return m?.[1].toLowerCase();
}

/**
 * Context menus need access keys on every item (Windows: "Assign access keys to
 * all menu items. No exceptions."): each label that has none gets the first of
 * its letters, preferring the first letter of each word, that no other item of
 * the same menu uses. Labels with an `&` of their own, role items (the system
 * names those) and separators are left alone; submenus are done the same way.
 * Returns a new template.
 */
export function withAccessKeys<T extends { label?: string; role?: string; type?: string; submenu?: unknown }>(items: T[]): T[] {
  const taken = new Set<string>();
  for (const it of items) if (it.label) taken.add(accessKeyOf(it.label) ?? '');
  return items.map((it) => {
    let out = it;
    if (Array.isArray(it.submenu)) out = { ...out, submenu: withAccessKeys(it.submenu as T[]) };
    const label = it.label;
    if (!label || it.role || it.type === 'separator' || label.includes('&')) return out;
    const letters = [...label];
    const isKey = (c: string) => /[\p{L}\p{N}]/u.test(c);
    const all = letters.map((_c, i) => i).filter((i) => isKey(letters[i]));
    const wordStarts = all.filter((i) => i === 0 || !isKey(letters[i - 1]));
    const at = [...wordStarts, ...all].find((i) => !taken.has(letters[i].toLowerCase()));
    if (at === undefined) return out;
    taken.add(letters[at].toLowerCase());
    return { ...out, label: `${letters.slice(0, at).join('')}&${letters.slice(at).join('')}` };
  });
}

/** Roles a remote client never gets: quitting from a phone would leave no way to start Looper again. */
const HOST_ONLY_ROLES = new Set(['quit']);

const SPEC_TYPES = new Set(['normal', 'separator', 'checkbox', 'radio', 'submenu']);

/** "&File" → "File", "Fish && Chips" → "Fish & Chips": the web has no access keys. */
export function stripMnemonic(label: string): string {
  return label.replace(/&(&?)/g, (_m, amp: string) => amp);
}

/** Electron's own ids for items without one ("123" and the like) aren't keys a page can name. */
const ownKey = (id: string | undefined): string | undefined => (id && !/^\d+$/.test(id) ? id : undefined);

/**
 * A menu as data for a client, and its items by the ids given them (the
 * path of indexes, "2.0.1"). Invisible items, host-only roles, items that
 * don't show on `platform` (when given) and the separators they leave
 * doubled or at an edge are left out. Without a platform the items keep
 * their marks, for the client to filter.
 */
export function serializeMenu(menu: MenuLike, platform?: UiPlatform): { items: MenuItemSpec[]; byId: Map<string, MenuItemLike> } {
  const byId = new Map<string, MenuItemLike>();
  const walk = (m: MenuLike, prefix: string): MenuItemSpec[] => {
    const out: MenuItemSpec[] = [];
    m.items.forEach((item, i) => {
      if (item.visible === false || (item.role && HOST_ONLY_ROLES.has(item.role.toLowerCase()))) return;
      if (platform && !showsOn(item.platforms, platform)) return;
      const id = prefix ? `${prefix}.${i}` : String(i);
      const type = item.submenu ? 'submenu' : SPEC_TYPES.has(item.type ?? 'normal') ? ((item.type ?? 'normal') as MenuItemSpec['type']) : 'normal';
      if (type === 'separator') {
        if (out.length && out[out.length - 1].type !== 'separator') out.push({ id, type, enabled: true });
        return;
      }
      byId.set(id, item);
      const spec: MenuItemSpec = { id, type, enabled: item.enabled !== false };
      if (item.label) spec.label = stripMnemonic(item.label);
      if (type === 'checkbox' || type === 'radio') spec.checked = !!item.checked;
      if (item.accelerator) spec.accelerator = item.accelerator;
      if (item.accelerator && item.registerAccelerator === false) spec.registerAccelerator = false;
      if (item.role) spec.role = item.role;
      const key = ownKey(item.id);
      if (key) spec.key = key;
      if (item.glyph) spec.icon = item.glyph;
      if (!platform && item.platforms) spec.platforms = [...item.platforms];
      if (item.submenu) spec.submenu = walk(item.submenu, id);
      out.push(spec);
    });
    while (out.length && out[out.length - 1].type === 'separator') out.pop();
    return out;
  };
  return { items: walk(menu, ''), byId };
}

/**
 * Hide a menu's items that don't show on `here` (MenuItem.visible can be set
 * at any time). For a menu built for one window: the desktop's native menus,
 * and a remote window's, whose serializeMenu then leaves them out.
 */
export function hideOffPlatform(menu: MenuLike, here: UiPlatform): void {
  for (const item of menu.items) {
    if (!showsOn(item.platforms, here)) item.visible = false;
    else if (item.submenu) hideOffPlatform(item.submenu, here);
  }
}

/**
 * Carry out a client's pick: Electron's own click wrapper runs, so radio
 * groups and `checked` behave as on the desktop. A checkbox starts from the
 * state opposite to the one the client reports, so the handler reads that.
 * Role items (copy, paste, reload…) are the client's to carry out.
 */
export function pickItem(item: MenuItemLike, window: unknown, webContents: unknown, checked?: boolean): void {
  if (item.role || item.enabled === false || typeof item.click !== 'function') return;
  if (item.type === 'checkbox' && typeof checked === 'boolean') item.checked = !checked;
  item.click({ triggeredByAccelerator: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }, window, webContents);
}
