import { pressKeys } from './list-nav';

/** A collapsible group header's keys (on the header itself, not a control in it): Enter or Space toggles, Right opens, Left closes. */
export function groupKeys(open: boolean, set: (open: boolean) => void) {
  const toggle = pressKeys(() => set(!open));
  return (e: { key: string; target: unknown; currentTarget: unknown; preventDefault: () => void }): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      set(e.key === 'ArrowRight');
    } else toggle(e);
  };
}
