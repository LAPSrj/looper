import type { MenuItemSpec } from '../shared/remote-access';

type MenuItem = Electron.MenuItemConstructorOptions;

/** Without separators doubled or at an edge. */
function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out[out.length - 1]?.type === 'separator') out.pop();
  return out;
}

/**
 * A menu a page sent as data, as Electron's. A pick comes back to the page as
 * the item's id (`pick`). `provide` fills in what only the main process knows,
 * by the item's key (the open windows); undefined leaves the item as it is.
 */
export function specTemplate(items: MenuItemSpec[], pick: (id: string) => void, provide: (key: string) => MenuItem[] | undefined = () => undefined): MenuItem[] {
  return tidy(
    items.flatMap((s): MenuItem[] => {
      const own = s.key ? provide(s.key) : undefined;
      if (own) return own;
      if (s.type === 'separator') return [{ type: 'separator' }];
      const submenu = s.submenu && specTemplate(s.submenu, pick, provide);
      if (submenu && !submenu.length) return [];
      return [
        {
          ...(s.key ? { id: s.key } : {}),
          label: s.label,
          enabled: s.enabled,
          ...(s.type === 'checkbox' || s.type === 'radio' ? { type: s.type, checked: !!s.checked } : {}),
          ...(s.accelerator ? { accelerator: s.accelerator } : {}),
          ...(s.registerAccelerator === false ? { registerAccelerator: false } : {}),
          ...(s.role ? { role: s.role as MenuItem['role'] } : {}),
          ...(s.icon ? { glyph: s.icon } : {}),
          ...(s.destructive ? { destructive: true as const } : {}),
          ...(submenu ? { submenu } : {}),
          ...(s.role || submenu ? {} : { click: () => pick(s.id) }),
        },
      ];
    }),
  );
}
