// Relative imports and no DOM types: the unit tests (node tsconfig) load this file.
import type { Presentation } from './nav-stack';

/** A button at a bar's trailing edge (iOS) or in the top app bar's actions (Android). */
export interface PageNavAction {
  id: string;
  label: string;
  /** An ICONS key (components/icons.tsx); the label is its accessible name. */
  icon?: string;
  /** A usage ring instead of an icon (components/ContextRing.tsx): the context used, and the 5-hour limit used, as fractions. */
  ring?: { context: number | null; used: number | null };
  disabled?: boolean;
  /** What it controls isn't at its default (a filter that's on): tinted. */
  on?: boolean;
  /** The button opens this menu of choices (a filter); `run` isn't called. */
  menu?: { id: string; label: string; checked?: boolean; type?: 'radio' | 'checkbox'; separator?: true; run: () => void }[];
  run: () => void;
}

/** An editor's Cancel or Confirm. */
export interface NavCommand {
  /** Default "Cancel" / "Save". */
  label?: string;
  disabled?: boolean;
  run: () => void;
}

/** Electron's &-mnemonics don't belong on a phone. */
export const plainLabel = (label: string | undefined): string => (label ?? '').replace(/&(&?)/g, (_m, amp: string) => amp);

/** The button at a bar's leading edge. */
export type BarLead =
  | { kind: 'back'; label: string; run: () => void }
  | { kind: 'cancel'; label: string; disabled?: boolean; run: () => void }
  | { kind: 'close'; label: string; run: () => void };

/** What a bar's container does when nothing of the page's takes the leading place. */
export type Dismiss = { kind: 'back' | 'close'; run: () => void } | null;

export interface BarInput {
  title: string;
  /** A short status line under the title. */
  subtitle?: string;
  /** The page shows a deeper screen of its own: Back returns from it. */
  back?: () => void;
  /** An editor's Cancel. */
  cancel?: NavCommand;
  /** An editor's Save, Create or other confirming action. */
  confirm?: NavCommand;
  actions?: PageNavAction[];
  dismiss: Dismiss;
}

export interface BarModel {
  lead: BarLead | null;
  title: string;
  subtitle: string | null;
  actions: PageNavAction[];
  confirm: { label: string; disabled?: boolean; run: () => void } | null;
}

/**
 * How a container closes on its own: a pushed screen goes back, an iOS sheet
 * and an Android dialog close; the root and an Android bottom sheet (dragged
 * down or tapped outside) have no button for it.
 */
export function dismissFor(pres: Presentation, run: { back: () => void; close: () => void }): Dismiss {
  if (pres === 'push') return { kind: 'back', run: run.back };
  if (pres === 'page-sheet' || pres === 'form-sheet' || pres === 'full-dialog' || pres === 'dialog') return { kind: 'close', run: run.close };
  return null;
}

/**
 * The one place a bar's buttons are decided, on every phone frame. The leading
 * button is the page's Back, else its Cancel, else the container's own Back or
 * Close; the trailing edge has the page's actions and its
 * Confirm.
 */
export function barModel(i: BarInput): BarModel {
  const back = i.back;
  const cancel = i.cancel;
  const lead: BarLead | null = back
    ? { kind: 'back', label: 'Back', run: back }
    : cancel
      ? { kind: 'cancel', label: plainLabel(cancel.label ?? 'Cancel'), disabled: cancel.disabled, run: cancel.run }
      : i.dismiss
        ? i.dismiss.kind === 'back'
          ? { kind: 'back', label: 'Back', run: i.dismiss.run }
          : { kind: 'close', label: 'Close', run: i.dismiss.run }
        : null;
  const confirm = i.confirm ? { label: plainLabel(i.confirm.label ?? 'Save'), disabled: i.confirm.disabled, run: i.confirm.run } : null;
  return { lead, title: plainLabel(i.title), subtitle: i.subtitle || null, actions: i.actions ?? [], confirm };
}
