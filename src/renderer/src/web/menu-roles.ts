import type { MenuItemSpec } from '../../../shared/remote-access';

/** A check box or radio item: it shows whether it's chosen. */
export const isChoice = (it: Pick<MenuItemSpec, 'type'>): boolean => it.type === 'checkbox' || it.type === 'radio';

/** A menu item's ARIA role. */
export const menuItemRole = (it: Pick<MenuItemSpec, 'type'>): 'menuitemcheckbox' | 'menuitemradio' | 'menuitem' =>
  it.type === 'checkbox' ? 'menuitemcheckbox' : it.type === 'radio' ? 'menuitemradio' : 'menuitem';
