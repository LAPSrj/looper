import { useEffect, useRef } from 'react';
import { isPhone } from '../web/page-nav';
import type { ToolbarGroup } from './toolbar-model';
import type { PageNavAction } from '../web/nav-bar-model';
import { useDialogKeys } from './hooks';
import { NavBar } from './NavBar';

/** A footer command: its label (when it has its own), whether it can run now, and what it does. */
export interface WindowAction {
  label?: string;
  disabled?: boolean;
  run: () => void;
}

/** A window's command that doesn't close it (Restore, Clear Filter). */
export interface WindowExtra {
  id: string;
  label: string;
  /** An ICONS key: a phone shows a lone Extra with an icon as a bar button. */
  icon?: string;
  disabled?: boolean;
  run: () => void;
}

interface Common {
  /** Commands that don't close the window: the bottom row's left end on the desktop, the bar or More on a phone. */
  extras?: WindowExtra[];
  /** Working (saving, starting): every button waits. */
  busy?: boolean;
}

/** An editor or a dialog that does something: Confirm | Cancel | Apply. */
interface ConfirmWindow extends Common {
  /** The window's task, a verb (Save, Create, Send, Run): the default button. */
  confirm: WindowAction & { label: string };
  /** Default: close the window. */
  cancel?: () => void;
  /** Save without closing, for an editor whose changes you'd want to see first. */
  apply?: WindowAction;
  /** Enter runs Confirm from anywhere, a list included (the template picker). */
  enterAnywhere?: boolean;
}

/** A window with nothing to confirm (a list whose changes apply at once): Close. */
interface CloseWindow extends Common {
  /** true: close the window; a function: what closes it (a dialog of the browser frame's own). */
  close: true | (() => void);
}

/** A dialog whose commit happens in its content (a file picked from a list): Cancel alone, abandoning the task. */
interface CancelWindow extends Common {
  cancel: () => void;
}

/** A wizard: Back | Next | Cancel, the commit step's Next named for what it does. */
interface WizardWindow extends Common {
  wizard: {
    /** Disabled on the first step. */
    back: WindowAction;
    next: WindowAction;
    /** The step that does the task: Next's label there, a verb (Import, Create), or Finish for a setting. */
    commit?: string;
    cancel?: () => void;
  };
}

export type WindowActionsProps = ConfirmWindow | CloseWindow | CancelWindow | WizardWindow;

const closeWindow = () => window.close();

/**
 * A window's actions, by role. The desktop draws them in its bottom row in the
 * Win32 order (Confirm | Cancel | Apply, Close, Cancel alone, or Back | Next |
 * Cancel, at the right; Extras at the left end), Enter runs the default and Esc
 * cancels or closes. A phone puts them in its bar
 * (scratch/ui-guidelines/window-actions.md).
 */
export function WindowActions(props: WindowActionsProps) {
  const { extras = [], busy } = props;
  const wizard = 'wizard' in props ? props.wizard : null;
  const confirm = 'confirm' in props ? props : null;
  const cancelOnly = !wizard && !confirm && 'cancel' in props ? props.cancel : null;
  const close = 'close' in props && typeof props.close === 'function' ? props.close : closeWindow;
  const cancel = wizard ? (wizard.cancel ?? closeWindow) : confirm ? (confirm.cancel ?? closeWindow) : (cancelOnly ?? close);
  const enter: (() => void) | undefined = wizard
    ? wizard.next.disabled || busy
      ? undefined
      : wizard.next.run
    : confirm
      ? confirm.confirm.disabled || busy
        ? undefined
        : confirm.confirm.run
      : cancel;
  useDialogKeys({ onSave: enter ? () => enter() : undefined, onCancel: busy ? undefined : cancel, enterAnywhere: confirm?.enterAnywhere });

  // Close, or Cancel alone, is the default when nothing else is: it takes the focus only when the window gave it to nothing else.
  const soleRef = useRef<HTMLButtonElement>(null);
  const sole = !wizard && !confirm;
  useEffect(() => {
    if (!sole) return;
    const active = document.activeElement;
    if (!active || active === document.body) soleRef.current?.focus();
  }, [sole]);

  if (isPhone) return <PhoneActions props={props} extras={extras} busy={busy} cancel={cancel} />;

  const btn = (label: string, run: () => void, opts: { primary?: boolean; disabled?: boolean; ref?: React.Ref<HTMLButtonElement> } = {}) => (
    <button key={label} type="button" ref={opts.ref} className={`btn${opts.primary ? ' primary' : ''}`} disabled={busy || opts.disabled} onClick={() => run()}>
      {label}
    </button>
  );
  return (
    <div className="editor-footer">
      {extras.length > 0 && (
        <div className="footer-extras">
          {extras.map((x) => (
            <button key={x.id} type="button" className="btn" disabled={busy || x.disabled} onClick={() => x.run()}>
              {x.label}
            </button>
          ))}
        </div>
      )}
      {wizard ? (
        <>
          {btn('Back', wizard.back.run, { disabled: wizard.back.disabled })}
          {btn(wizard.commit ?? 'Next', wizard.next.run, { primary: true, disabled: wizard.next.disabled })}
          {btn('Cancel', cancel)}
        </>
      ) : confirm ? (
        <>
          {btn(confirm.confirm.label, confirm.confirm.run, { primary: true, disabled: confirm.confirm.disabled })}
          {btn('Cancel', cancel)}
          {confirm.apply && btn(confirm.apply.label ?? 'Apply', confirm.apply.run, { disabled: confirm.apply.disabled })}
        </>
      ) : cancelOnly ? (
        btn('Cancel', cancelOnly, { ref: soleRef })
      ) : (
        btn('Close', close, { ref: soleRef })
      )}
    </div>
  );
}

/**
 * A phone: Cancel is the bar's xmark (Cancel alone too), Confirm its checkmark,
 * Apply isn't shown and Close is the frame's own xmark or Back. A lone Extra with an icon is a bar
 * button; any other Extras are in More. A wizard's later steps have Back in
 * Cancel's place, Next as a text button and the commit step's button as the
 * confirming one (iOS's checkmark, Android's text button).
 */
function PhoneActions({ props, extras, busy, cancel }: { props: WindowActionsProps; extras: WindowExtra[]; busy?: boolean; cancel: () => void }) {
  const lone = extras.length === 1 && extras[0].icon ? extras[0] : null;
  const actions: PageNavAction[] = lone ? [{ id: lone.id, label: lone.label, icon: lone.icon, disabled: busy || lone.disabled, run: lone.run }] : [];
  const toolbar: ToolbarGroup[] | undefined =
    !lone && extras.length > 0
      ? [{ id: 'window-extras', items: extras.map((x) => ({ id: x.id, label: x.label, icon: x.icon, enabled: !busy && !x.disabled, run: x.run })) }]
      : undefined;
  if ('wizard' in props) {
    const w = props.wizard;
    const first = !!w.back.disabled;
    const next = w.commit ? undefined : { id: 'wizard-next', label: 'Next', disabled: busy || w.next.disabled, run: w.next.run };
    return (
      <NavBar
        cancel={first ? { disabled: busy, run: cancel } : undefined}
        back={first ? undefined : w.back.run}
        confirm={w.commit ? { label: w.commit, disabled: busy || w.next.disabled, run: w.next.run } : undefined}
        actions={next ? [...actions, next] : actions}
        toolbar={toolbar}
        order={2}
      />
    );
  }
  if ('confirm' in props) {
    const c = props.confirm;
    return <NavBar cancel={{ disabled: busy, run: cancel }} confirm={{ label: c.label, disabled: busy || c.disabled, run: c.run }} actions={actions} toolbar={toolbar} order={2} />;
  }
  if ('cancel' in props) return <NavBar cancel={{ disabled: busy, run: cancel }} actions={actions} toolbar={toolbar} order={2} />;
  return actions.length || toolbar ? <NavBar actions={actions} toolbar={toolbar} order={2} /> : null;
}
