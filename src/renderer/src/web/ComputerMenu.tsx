import { useMemo } from 'react';
import { Menu } from '../components/Menu';
import type { ShellController } from './controller';
import type { OpenMenu } from './store';

/** A menu the computer popped up over one of its windows (a right-click or a long press), placed at the pointer or out of the control it named. */
export function ComputerMenu({ controller, menu: m }: { controller: ShellController; menu: OpenMenu }) {
  const at = useMemo(() => controller.popupPoint(m), [controller, m]);
  const control = useMemo(() => controller.popupButton(m), [controller, m]);
  const place = useMemo(() => ({ kind: 'point' as const, x: at.x, y: at.y, control }), [at, control]);
  return <Menu items={m.items} place={place} popup isMac={controller.isMac} onPick={(it) => controller.pick(m.menuId, m.w, it)} onClose={() => controller.dismissMenu(m.menuId)} />;
}
