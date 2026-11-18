import { useContext, useState, type ReactNode } from 'react';
import { isPhone } from '../web/page-nav';
import { InPanel, InspectorHost } from './ListDetail';
import { PhoneSheet } from './phone/PhoneSheet';
import { Splitter } from './SplitPane';

/**
 * What a supporting panel shows, and whether it does. Beside the content (`beside`) it's
 * open until it's closed; as a sheet it's closed until something asks for it.
 */
export function useInspector<T>(initial: T, beside: boolean) {
  const [column, setColumn] = useState({ open: true, tab: initial, opens: 0 });
  const [sheet, setSheet] = useState<T | null>(null);
  return {
    open: beside ? column.open : sheet !== null,
    tab: beside ? column.tab : (sheet ?? initial),
    /** A show in the column starts it over on its tab. */
    showKey: column.opens,
    /** A sheet is up: the frame's bar can't be used meanwhile. */
    sheetOpen: !beside && sheet !== null,
    show: (tab: T = initial) => (beside ? setColumn((c) => ({ open: true, tab, opens: c.opens + 1 })) : setSheet(tab)),
    /** The bar's button: it shows or hides the column, or opens the sheet. */
    toggle: () => (beside ? setColumn((c) => ({ ...c, open: !c.open })) : setSheet(initial)),
    /** Something in the panel opened a page: a sheet goes away for it, a column stays. */
    dismiss: () => setSheet(null),
  };
}

export interface InspectorProps {
  title: string;
  open: boolean;
  /** Closes the sheet. */
  onClose?: () => void;
  children: ReactNode;
}

/**
 * A panel that only makes sense beside what it's about (Activity). The desktop
 * draws a pane with a splitter; a wide tablet a column at the trailing edge when
 * the ListDetail around it leaves room for one; anything else a sheet
 * (scratch/platforms.md, Supporting panel).
 */
export function Inspector({ title, open, onClose, children }: InspectorProps) {
  const { split, splitter } = useContext(InspectorHost);
  if (!open) return null;
  if (!isPhone) {
    return (
      <>
        {splitter && <Splitter className="sidebar-divider" axis="x" label={`Resize ${title}`} {...splitter} />}
        {children}
      </>
    );
  }
  return (
    <InPanel.Provider value={true}>
      {split?.inspector ? (
        <aside className="pg-split-inspector" aria-label={title}>
          {children}
        </aside>
      ) : (
        <PhoneSheet title={title} onClose={onClose ?? (() => undefined)}>
          {children}
        </PhoneSheet>
      )}
    </InPanel.Provider>
  );
}
