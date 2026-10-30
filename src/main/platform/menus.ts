import type { MenuItemSpec } from '../../shared/remote-access';

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
  /** Electron's wrapper, click(event, window, webContents): it flips `checked` for checkbox and radio items, then calls the template's click(item, window, event). */
  click?: Function;
}

export interface MenuLike {
  items: MenuItemLike[];
}

/** Roles a remote client never gets: quitting from a phone would leave no way to start Looper again. */
const HOST_ONLY_ROLES = new Set(['quit']);

const SPEC_TYPES = new Set(['normal', 'separator', 'checkbox', 'radio', 'submenu']);

/** "&File" → "File", "Fish && Chips" → "Fish & Chips": the web has no access keys. */
export function stripMnemonic(label: string): string {
  return label.replace(/&(&?)/g, (_m, amp: string) => amp);
}

/**
 * A menu as data for a client, and its items by the ids given them (the
 * path of indexes, "2.0.1"). Invisible items, host-only roles and the
 * separators they leave doubled or at an edge are left out.
 */
export function serializeMenu(menu: MenuLike): { items: MenuItemSpec[]; byId: Map<string, MenuItemLike> } {
  const byId = new Map<string, MenuItemLike>();
  const walk = (m: MenuLike, prefix: string): MenuItemSpec[] => {
    const out: MenuItemSpec[] = [];
    m.items.forEach((item, i) => {
      if (item.visible === false || (item.role && HOST_ONLY_ROLES.has(item.role.toLowerCase()))) return;
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
      if (item.submenu) spec.submenu = walk(item.submenu, id);
      out.push(spec);
    });
    while (out.length && out[out.length - 1].type === 'separator') out.pop();
    return out;
  };
  return { items: walk(menu, ''), byId };
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
