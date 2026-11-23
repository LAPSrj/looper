import { Children, cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, ComponentProps, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react';
import type { MenuItemSpec } from '@shared/remote-access';
// On a phone, marks the window's page and keeps the keyboard and safe-area insets its styles use.
import './phone/keyboard';
import { platform } from '../platform';
import { isPhone } from '../web/page-nav';
import { EmptyState } from './EmptyState';
import { mergeStoredWidths, shownWidth } from './fit-columns';
import { NavBar } from './NavBar';
import { bindField, textOptions, type TextOptions } from './field-model';
import { StatusGlyph, type StatusLevel } from './icons';
import { Group, Row, Segmented } from './phone/PhoneList';
import { Tabs, useCtrlTab } from './Tabs';
import { WindowActions } from './WindowActions';

export const onIos = isPhone && platform === 'ios';

/** A check box with its text after it. `note`: a line under it (its status, what it's for). */
export function CheckboxField({
  label,
  note,
  checked,
  onChange,
  disabled,
  autoFocus,
  indeterminate,
  className,
}: {
  label: ReactNode;
  note?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Partly checked: some of the things it stands for are on. */
  indeterminate?: boolean;
  className?: string;
}) {
  if (note) {
    return (
      <div className="checkbox-with-note">
        <CheckboxField label={label} checked={checked} onChange={onChange} disabled={disabled} autoFocus={autoFocus} indeterminate={indeterminate} className={className} />
        <span className="checkbox-note">{note}</span>
      </div>
    );
  }
  return (
    <label className={`checkbox-field${className ? ` ${className}` : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        autoFocus={autoFocus && !isPhone}
        ref={indeterminate === undefined ? undefined : (el) => void (el && (el.indeterminate = indeterminate))}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

/**
 * A labelled group of radio buttons, one per option, stacked vertically; on an iPhone, rows with a check on the chosen one.
 * `hideLabel`: the label only names the group (the check box above it says what it's for).
 */
export function RadioField<T extends string>({
  label,
  hideLabel,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  hideLabel?: boolean;
  name: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  if (onIos) return <CheckRows label={label} hideLabel={hideLabel} value={value} options={options} onChange={onChange} />;
  return (
    <div className="radio-field" role="radiogroup" aria-label={label}>
      {!hideLabel && <span className="field-label">{label}</span>}
      {options.map(([v, text]) => (
        <label key={v} className="checkbox-field radio-option">
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
          {text}
        </label>
      ))}
    </div>
  );
}

/**
 * A labelled group of check boxes for choosing several of a list (the files a commit takes), each with its description
 * under it; a long list scrolls inside its box, so a dialog keeps its size. On an iPhone, rows with a check on each
 * chosen one (HIG: Lists and tables). `error`: a problem with what's chosen, under the group.
 */
export function CheckboxGroup({
  label,
  options,
  checked,
  onChange,
  error,
  autoFocus,
}: {
  label: string;
  options: { value: string; label: string; description?: string }[];
  checked: readonly string[];
  onChange: (value: string, on: boolean) => void;
  error?: string;
  autoFocus?: boolean;
}) {
  const problem = error && <FieldError>{error}</FieldError>;
  if (onIos) {
    return (
      <div className="radio-rows checkbox-group" role="group" aria-label={label}>
        <Group title={label}>
          {options.map((o) => (
            <Row key={o.value} title={o.label} sub={o.description} checked={checked.includes(o.value)} multiple onOpen={() => onChange(o.value, !checked.includes(o.value))} />
          ))}
        </Group>
        {problem}
      </div>
    );
  }
  return (
    <div className="radio-field checkbox-group" role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      <div className="checkbox-group-box">
        {options.map((o, n) => (
          <CheckboxField
            key={o.value}
            className="radio-option"
            label={o.label}
            note={o.description}
            checked={checked.includes(o.value)}
            autoFocus={autoFocus && n === 0}
            onChange={(on) => onChange(o.value, on)}
          />
        ))}
      </div>
      {problem}
    </div>
  );
}

/** iOS's choice of one: a row per option, a check on the chosen one (a radio group for assistive technology). */
function CheckRows<T extends string>({
  label,
  hideLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  hideLabel?: boolean;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  const chosen = Math.max(0, options.findIndex(([v]) => v === value));
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const to = (chosen + step + options.length) % options.length;
    onChange(options[to][0]);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };
  return (
    <div className="radio-rows" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      <Group title={hideLabel ? undefined : label}>
        {options.map(([v, text], i) => (
          <Row key={v} title={text} checked={value === v} tabIndex={i === chosen ? 0 : -1} onOpen={() => onChange(v)} />
        ))}
      </Group>
    </div>
  );
}

/**
 * A WinUI InfoBar: a status that needs the user, shown inline until it's
 * resolved, with no close button. `level` is its severity (informational
 * unless set). `stacked` puts the title on its own line, as WinUI does when
 * the text doesn't fit one.
 */
export function InfoBar({
  title,
  message,
  action,
  stacked,
  level = 'info',
}: {
  title: string;
  message: ReactNode;
  action?: ReactNode;
  stacked?: boolean;
  level?: StatusLevel;
}) {
  return (
    <div className={`infobar${level !== 'info' ? ` infobar-${level}` : ''}${stacked ? ' infobar-stacked' : ''}`} role="status">
      <StatusGlyph level={level} />
      <div className="infobar-text">
        <span className="infobar-title">{title}</span>
        <span className="infobar-message">{message}</span>
        {action && <span className="infobar-action">{action}</span>}
      </div>
    </div>
  );
}

/** A page's main instruction, at its top: what to do there or the question it asks (a wizard's step). One per page. */
export function MainInstruction({ children }: { children: ReactNode }) {
  return <h2 className="main-instruction">{children}</h2>;
}

/** A label and its control, tied together so the control is named by the label (and a click on the label focuses it). */
/**
 * A problem with what's in a field, under it: Windows' in-place error, normal text after a 16x16 error icon. An iPhone
 * has no in-place error, so there it's an alert each time the problem changes (Apple's alerts tell about a problem),
 * and the text stays hidden under the field for assistive technology.
 */
export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  if (onIos) return <IosFieldAlert id={id}>{children}</IosFieldAlert>;
  return (
    <p className="field-error" id={id} role="alert">
      <StatusGlyph level="error" />
      <span>{children}</span>
    </p>
  );
}

function IosFieldAlert({ id, children }: { id?: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState('');
  useLayoutEffect(() => setText(ref.current?.textContent?.trim() ?? ''));
  useEffect(() => {
    // An alert's title that's a sentence ends with its punctuation (HIG Alerts).
    if (text) void window.looper.showError(/[.?!]$/.test(text) ? text : `${text}.`);
  }, [text]);
  return (
    <span ref={ref} id={id} hidden>
      {children}
    </span>
  );
}

export function Field({ label, help, error, children }: { label: string; help?: ReactNode; /** A problem with what's in it: under it, and its control marked invalid. */ error?: string; children: ReactNode }) {
  const id = useId();
  const labelId = `${id}-label`;
  const errorId = `${id}-error`;
  const bound = bindField(children, id, error ? { 'aria-invalid': true, 'aria-describedby': errorId } : undefined);
  const labelEl = (
    <label id={labelId} className="field-label" htmlFor={bound.controlId}>
      {label}
    </label>
  );
  // An iPhone's row: the label and the first control on one line, any other control on a line of its own.
  const [first, ...others] = onIos && bound.oneLine ? Children.toArray(bound.children) : [];
  return (
    <div className={`field${bound.oneLine ? ' field-one-line' : ''}`} role={bound.group ? 'group' : undefined} aria-labelledby={bound.group ? labelId : undefined}>
      {first ? (
        <>
          <div className="field-line">
            {labelEl}
            {first}
          </div>
          {others}
        </>
      ) : (
        <>
          {labelEl}
          {bound.children}
        </>
      )}
      {error && <FieldError id={errorId}>{error}</FieldError>}
      {help && <p className="help">{help}</p>}
    </div>
  );
}

/**
 * Fields that belong together: on an iPhone one inset card with a row per field and a hairline between rows,
 * however they nest (FieldRow, StepFields, InlineField); on every other platform it adds no box.
 * `title` names the group: a header above the card on an iPhone, a label above the fields elsewhere.
 */
export function FormGroup({ title, children }: { title?: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <div className="form-group" role={title ? 'group' : undefined} aria-labelledby={title ? titleId : undefined}>
      {title && (
        <div id={titleId} className="field-label form-group-title">
          {title}
        </div>
      )}
      <div className="form-group-rows">{children}</div>
    </div>
  );
}

/** Fields side by side on a desktop; on a phone they stack like any others. */
export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="row">{children}</div>;
}

/**
 * A choice and, while it applies, a from-to pair: on one line, or on an iPhone
 * a row each. `box`: draws one bound, given the name a shared line needs.
 */
export function RangeField({ label, mode, on, box, fromLabel, toLabel }: { label: string; mode: ReactNode; on: boolean; box: (bound: 'from' | 'to', label?: string) => ReactNode; fromLabel: string; toLabel: string }) {
  if (onIos) {
    return (
      <>
        <Field label={label}>{mode}</Field>
        {on && (
          <>
            <Field label="From">{box('from')}</Field>
            <Field label="To">{box('to')}</Field>
          </>
        )}
      </>
    );
  }
  return (
    <Field label={label}>
      <InputRow className="hours-row">
        {mode}
        {on && (
          <>
            {box('from', fromLabel)}
            <span className="muted">to</span>
            {box('to', toLabel)}
          </>
        )}
      </InputRow>
    </Field>
  );
}

/**
 * A checkbox whose text runs into a number box on the same line ("larger than [200 k tokens]").
 * On an iPhone the number is a row of its own, named by the box's `label`, and shows only while it applies.
 */
export function InlineField({ children }: { children: ReactNode }) {
  if (onIos) {
    const [box, number] = Children.toArray(children) as [ReactNode, ReactElement<NumberInputProps>];
    return (
      <div className="inline-field">
        {box}
        {!number.props.disabled && <Field label={number.props.label ?? ''}>{cloneElement(number, { label: undefined })}</Field>}
      </div>
    );
  }
  return <div className="inline-field">{children}</div>;
}

/** A text box with its unit inside it at the right edge. */
export function InputSuffix({ suffix, className, children }: { suffix?: string; className?: string; children: ReactNode }) {
  return (
    <div className={`input-suffix${className ? ` ${className}` : ''}`}>
      {children}
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

/**
 * A form's one-line box (also time and date). A phone gets no focus on its own: its window opens
 * without a keyboard, and the Return key says Done, as it runs the window's default button.
 * On an iPhone an empty box says so (it has no outline to show where it is), and a box being edited has the Clear button at its end (HIG: Text fields).
 * `selectWhen`: the text is selected once this turns true (a rename, so typing replaces it).
 */
export function TextInput({ code, verbatim, selectWhen, className, autoFocus, ...rest }: ComponentProps<'input'> & TextOptions & { selectWhen?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectWhen && !isPhone) ref.current?.select();
  }, [selectWhen]);
  const input = <input ref={ref} enterKeyHint="done" autoFocus={autoFocus && !isPhone} {...textOptions({ code, verbatim }, className)} {...rest} />;
  const clearable = onIos && !rest.readOnly && !rest.disabled && (rest.type === undefined || rest.type === 'text');
  if (!clearable) return input;
  const hinted = rest.placeholder === undefined ? cloneElement(input, { placeholder: 'Not Set' }) : input;
  const clear = () => {
    const el = ref.current;
    if (!el) return;
    // A value set directly doesn't reach React; the prototype's setter and an input event do.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  return (
    <span className="text-control">
      {hinted}
      <button type="button" tabIndex={-1} className="input-clear" aria-label="Clear" hidden={!rest.value} onPointerDown={(e) => e.preventDefault()} onClick={clear}>
        <svg width="17" height="17" viewBox="0 0 17 17" aria-hidden="true">
          <circle cx="8.5" cy="8.5" r="8.5" fill="currentColor" />
          <path d="m5.8 5.8 5.4 5.4m0-5.4-5.4 5.4" fill="none" stroke="var(--pg-cell)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}
TextInput.labelable = true;

/** A form's text box of several lines. */
export function TextArea({ code, verbatim, className, autoFocus, ...rest }: ComponentProps<'textarea'> & TextOptions) {
  return <textarea autoFocus={autoFocus && !isPhone} {...textOptions({ code, verbatim }, className)} {...rest} />;
}
TextArea.labelable = true;
TextArea.multiline = true;

/** A form's drop-down: the platform's own list, and no focus on its own on a phone. */
export function SelectInput({ autoFocus, ...rest }: ComponentProps<'select'>) {
  if (onIos) return <IosPopUp {...rest} />;
  return <select autoFocus={autoFocus && !isPhone} {...rest} />;
}

/** A select's options as a pop-up button's menu items: the chosen one checked, their `&` kept as text. */
export const popUpItems = (options: readonly HTMLOptionElement[]): MenuItemSpec[] =>
  options.map((o, i) => ({ id: String(i), type: 'radio', label: o.text.trim().replace(/&/g, '&&'), checked: o.selected, enabled: !o.disabled }));

/**
 * iOS's pop-up button: the chosen option as ordinary text that wraps at the row's end, with the up-and-down
 * chevrons. A tap on it (in a form, anywhere on the row) opens Looper's menu out of the value, lined up with its
 * trailing edge, as a list row's pop-up button opens (ios.md: Menus; IosMenu's placePopUp): the system's menu for a
 * select opened centered over the whole row and covered its label. The select stays, unseen, for the value and
 * onChange.
 */
export function IosPopUp({ onChange, id, disabled, 'aria-label': ariaLabel, 'aria-labelledby': labelledBy, ...rest }: ComponentProps<'select'>) {
  const ref = useRef<HTMLSelectElement>(null);
  const valueRef = useRef<HTMLSpanElement>(null);
  const valueId = useId();
  const [text, setText] = useState('');
  const sync = () => setText(ref.current?.selectedOptions[0]?.text.trim() ?? '');
  useLayoutEffect(sync);
  const open = () => {
    const select = ref.current;
    const at = valueRef.current?.getBoundingClientRect();
    if (!select || !at) return;
    const options = [...select.options];
    const button = { x: at.left, y: at.top, width: at.width, height: at.height };
    void window.looper.commands.popup(popUpItems(options), { x: at.left, y: at.bottom, button }).then((picked) => {
      const option = picked === null ? undefined : options[Number(picked)];
      if (!option || option.selected) return;
      select.value = option.value;
      // React's onChange for a select listens for the change event.
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  return (
    <span className={`select-control${disabled ? ' disabled' : ''}`}>
      <span ref={valueRef} id={valueId} className="select-value">
        {text}
      </span>
      <button type="button" id={id} className="select-hit" aria-haspopup="menu" aria-label={ariaLabel} aria-labelledby={labelledBy} aria-describedby={valueId} disabled={disabled} onClick={open} />
      <select
        ref={ref}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => {
          onChange?.(e);
          sync();
        }}
        {...rest}
      />
    </span>
  );
}
SelectInput.labelable = true;

interface NumberInputProps {
  /** The unit, inside the box at its right edge; omit for a plain number (a port). */
  suffix?: string;
  /** null: no number yet (an empty box). */
  value: number | null;
  onChange: (n: number) => void;
  /** Set by a Field around it. */
  id?: string;
  /** A name for it when no Field's label names it (the second box of a pair). */
  label?: string;
  /** Fired when focus leaves the input, with the value as it was brought into range; the place to normalize against other fields. */
  onBlur?: (value: number | null) => void;
  /** The range: any number goes to onChange while typing, and leaving the box brings the value into it. */
  min?: number;
  max?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** A class on the box's wrapper, for a box outside a form (the image window's zoom). */
  className?: string;
}

export function NumberInput({ suffix, value, onChange, onBlur, min, max, disabled, autoFocus, id, label, className }: NumberInputProps) {
  // What's typed, while it's being typed: a cleared box, or a number the field didn't take, shows until the box is left.
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <InputSuffix suffix={suffix} className={className}>
      <input
        id={id}
        aria-label={label}
        type="number"
        inputMode="numeric"
        enterKeyHint="done"
        min={min}
        max={max}
        disabled={disabled}
        autoFocus={autoFocus && !isPhone}
        value={typed ?? value ?? ''}
        onChange={(e) => {
          setTyped(e.target.value);
          // A cleared field is a keystroke on the way to a new number, not a 0.
          if (e.target.value === '') return;
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        onBlur={() => {
          // What was typed, brought into range: a field that refused it (a schedule can't hold 60 minutes) takes the nearest it can.
          const n = typed !== null && typed !== '' && !Number.isNaN(Number(typed)) ? Number(typed) : value;
          setTyped(null);
          const inRange = n === null ? null : Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
          if (inRange !== null && inRange !== value) onChange(inRange);
          onBlur?.(inRange);
        }}
      />
    </InputSuffix>
  );
}

/**
 * The fields that depend on a checkbox right above them: indented under it, and dimmed and disabled while it's off (hidden on an iPhone).
 * Stacked like the rest of the form, or with `row` side by side (Settings' stagger delays) or a lone sub-option that sits tight under its checkbox.
 */
export function StepFields({
  on,
  when = true,
  row,
  children,
}: {
  on: boolean;
  /** False: the fields have no checkbox above them (no project), and show as they are. */
  when?: boolean;
  row?: boolean;
  children: ReactNode;
}) {
  if (!when) return <>{children}</>;
  // iOS shows a row only while it applies; everywhere else it stays visible, dimmed.
  if (onIos && !on) return null;
  return (
    <fieldset className={`step-fields ${row ? 'step-row' : 'step-stack'}${on ? '' : ' disabled'}`} disabled={!on}>
      {children}
    </fieldset>
  );
}

/** Controls side by side on one line: a text box and its buttons (Browse…), or a pair of number boxes. */
export function InputRow({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`input-row${className ? ` ${className}` : ''}`}>{children}</div>;
}

/**
 * Several of a short list chosen at once (days of the week, effort levels), one always staying on: check boxes in a
 * row on the desktop ("Don't use command buttons to set state. Use radio buttons or check boxes instead", Win32
 * Command buttons), a switch row each on a phone (CheckboxField; ios.md Switch: only in a list row).
 * `wrap`: many short choices (days of the month), seven to a line on the desktop.
 */
export function CheckboxChoices<T extends string | number>({
  options,
  value,
  onChange,
  label,
  wrap,
}: {
  options: readonly (readonly [T, string])[];
  value: readonly T[];
  onChange: (next: T[]) => void;
  /** Names the group when no Field's label does. */
  label?: string;
  wrap?: boolean;
}) {
  return (
    <div className={`checkbox-choices${wrap ? ' checkbox-choices-wrap' : ''}`} role="group" aria-label={label}>
      {options.map(([v, text]) => {
        const on = value.includes(v);
        return (
          <CheckboxField
            key={v}
            label={text}
            checked={on}
            disabled={on && value.length === 1}
            onChange={(checked) => onChange(checked ? [...value, v] : value.filter((x) => x !== v))}
          />
        );
      })}
    </div>
  );
}

/** Tells a Field around a component that the component puts its `id` on an input. */
NumberInput.labelable = true;

export function NumberField({ label, ...rest }: { label: string } & NumberInputProps) {
  return (
    <Field label={label}>
      <NumberInput {...rest} />
    </Field>
  );
}

/** Up to this many tabs, a phone draws them as iOS's segmented control or Material's fixed tabs, while their labels fit (Segmented's onFit). */
const SEGMENTS = 5;
/** Up to this many tabs with `panels`, an iPhone shows them all on one page. */
const ONE_PAGE = 3;

/**
 * A window's tabs (a thin wrapper over Tabs). With `sections`, the tabs'
 * panel is the TabBar's `children`: a phone or tablet shows the sections as a list of
 * rows and a section's panel in a screen of its own, which Back leaves; the
 * desktop shows the tabs with the panel below.
 * With `panels`, the TabBar draws the window's body: an iPhone shows a short
 * window as one page, each later tab's name heading its part; every other
 * platform shows the tabs with the active panel below.
 * `overflow` says what an iPhone or iPad shows for tabs a segmented control
 * can't hold (more than five, or labels too long): a pop-up button, or with
 * 'sections' the same list of rows as `sections` (the TabBar's `children` are
 * then the panel, and a screen that has a detail pushed in it says so with
 * `hidden`, which only the tab strip gives way to: the rows' own bar yields to
 * the detail's by order). When the tabs do fit, the segmented control stays.
 */
export function TabBar<T extends string>({
  tabs,
  active,
  onSelect,
  className,
  label = 'Sections',
  sections,
  overflow = 'popup',
  hidden,
  startOpen,
  panels,
  ctrlTab,
  children,
}: {
  tabs: readonly (readonly [T, string])[];
  active: T;
  onSelect: (id: T) => void;
  className?: string;
  /** Ctrl+Tab and Ctrl+Shift+Tab cycle the tabs while the window has focus (see Tabs); one strip per window. */
  ctrlTab?: boolean;
  /** The tab list's accessible name. */
  label?: string;
  sections?: boolean;
  /** iOS: what shows for tabs a segmented control can't hold: a pop-up button (HIG Pop-up buttons) or the list of rows of `sections`, whose rows open the `children`. */
  overflow?: 'popup' | 'sections';
  /** The screen shows a pushed detail with a bar of its own, so the tab strip gives way to it (the rows' own bar yields by order). */
  hidden?: boolean;
  /** With rows, the panel of the `active` tab is open at the start, not the list. */
  startOpen?: boolean;
  panels?: (id: T) => ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(!!startOpen);
  // Whether the segments (iOS) or fixed tabs (Material) fit (Segmented's onFit); while they don't, the scrolling strip shows instead.
  const [segmentsFit, setSegmentsFit] = useState(true);
  // iOS has no tab strip: tabs a segmented control can't hold are rows (`overflow` 'sections') or a pop-up button (below), which Ctrl+Tab still cycles.
  const fits = tabs.length <= SEGMENTS && segmentsFit;
  const overflowRows = onIos && !sections && overflow === 'sections' && !fits;
  const popUp = onIos && !sections && !overflowRows && !fits;
  useCtrlTab(
    tabs.map(([id]) => id),
    active,
    onSelect as (id: string) => void,
    ctrlTab && popUp,
  );
  const rows = isPhone && (!!sections || overflowRows);
  const close = () => setOpen(false);
  if (rows) {
    // The segments are out of the way while the rows show, but measured (drawn at no height) so the rows give way to them when the room grows.
    const probe = overflowRows && tabs.length <= SEGMENTS && (
      <Segmented items={tabs} value={active} onChange={onSelect} label={label} onFit={setSegmentsFit} probe />
    );
    if (open) {
      return (
        <>
          {probe}
          <NavBar title={tabs.find(([id]) => id === active)?.[1]} back={close} order={3} />
          {children}
        </>
      );
    }
    return (
      <>
        {probe}
        <div className="pg-scroll tab-sections">
          <Group>
            {tabs.map(([id, text]) => (
              <Row
                key={id}
                title={text}
                chevron
                onOpen={() => {
                  onSelect(id);
                  setOpen(true);
                }}
              />
            ))}
          </Group>
        </div>
      </>
    );
  }
  if (onIos && panels && tabs.length <= ONE_PAGE) {
    return (
      <div className="editor-body tab-page">
        {tabs.map(([id, text], i) => (
          <section key={id}>
            {i > 0 && <h2 className="pg-group-title">{text}</h2>}
            {panels(id)}
          </section>
        ))}
      </div>
    );
  }
  const segments = isPhone && !sections && tabs.length <= SEGMENTS;
  return (
    <>
      {segments && (
        <Segmented
          items={tabs}
          value={active}
          onChange={onSelect}
          label={label}
          ctrlTab={ctrlTab}
          className={`pg-segmented tabs-segmented${className ? ` ${className}` : ''}`}
          onFit={setSegmentsFit}
          probe={!segmentsFit || hidden}
        />
      )}
      {hidden ? null : popUp ? (
        // HIG Segmented controls: about five segments at most on iPhone; HIG Pop-up buttons: "a flat list of mutually
        // exclusive options", "when space is limited and you don't need to display all options all the time".
        <div className={`tabs-popup${className ? ` ${className}` : ''}`}>
          <SelectInput aria-label={label} value={active} onChange={(e) => onSelect(e.target.value as T)}>
            {tabs.map(([id, text]) => (
              <option key={id} value={id}>
                {text}
              </option>
            ))}
          </SelectInput>
        </div>
      ) : (
        (!segments || !segmentsFit) && (
          <Tabs tabs={tabs.map(([id, text]) => ({ id, label: text }))} active={active} onSelect={(id) => onSelect(id as T)} label={label} ctrlTab={ctrlTab} className={className} />
        )
      )}
      {panels ? <div className="editor-body">{panels(active)}</div> : children}
    </>
  );
}

export interface TableCol {
  label: string;
  /** Starting width in px; omit for the flex column that takes the remaining space. */
  width?: number;
  min?: number;
  /** A share of the table's width, that can't be dragged (in place of `width`). */
  percent?: number;
  /** Right-aligned numbers. */
  num?: boolean;
}

/** Stored widths keyed by column label, so entries survive column reorder/insertion; those of columns the pane is too narrow for stay. */
export function readStoredWidths(storageKey: string | undefined): Record<string, unknown> {
  if (!storageKey) return {};
  try {
    const raw = localStorage.getItem(`col-widths:${storageKey}`);
    const stored: unknown = raw ? JSON.parse(raw) : null;
    return stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function loadStoredWidths(storageKey: string | undefined, cols: readonly TableCol[]): (number | undefined)[] {
  const stored = readStoredWidths(storageKey);
  return cols.map((c) => shownWidth(c, stored));
}

/**
 * Colgroup + header row for a fixed-layout table, with per-column drag-resize.
 * Drop it directly inside a `<table>`, before the tbody. With a `storageKey`,
 * widths persist in localStorage (saved on drag end, only where they differ
 * from the defaults); double-clicking a handle resets its column.
 */
export function ResizableColumns({ cols, storageKey, onSaved }: { cols: readonly TableCol[]; storageKey?: string; onSaved?: () => void }) {
  const [widths, setWidths] = useState<(number | undefined)[]>(() => loadStoredWidths(storageKey, cols));
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const save = (w: readonly (number | undefined)[]) => {
    if (!storageKey) return;
    try {
      localStorage.setItem(`col-widths:${storageKey}`, JSON.stringify(mergeStoredWidths(readStoredWidths(storageKey), cols, w)));
    } catch {
      /* storage unavailable: widths just don't persist */
    }
    onSaved?.();
  };

  const startDrag = (i: number, e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widths[i] ?? cols[i].width ?? 0;
    const min = cols[i].min ?? 40;
    document.body.style.cursor = 'col-resize';
    const onMove = (me: MouseEvent) => {
      setWidths((w) => {
        const next = [...w];
        next[i] = Math.max(min, startW + me.clientX - startX);
        return next;
      });
    };
    const onUp = () => {
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      save(widthsRef.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const reset = (i: number) => {
    const next = [...widthsRef.current];
    next[i] = cols[i].width;
    setWidths(next);
    save(next);
  };

  return (
    <>
      <colgroup>
        {cols.map((c, i) => (
          <col key={i} style={widths[i] !== undefined ? { width: widths[i] } : c.percent !== undefined ? { width: `${c.percent}%` } : undefined} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={i} className={c.num ? 'num' : undefined}>
              {c.label}
              {widths[i] !== undefined && (
                <span className="col-resize" onMouseDown={(e) => startDrag(i, e)} onDoubleClick={() => reset(i)} />
              )}
            </th>
          ))}
        </tr>
      </thead>
    </>
  );
}

/**
 * An editor window's whole body while it has nothing to show: Loading…, or why
 * not (`gone`: "This task no longer exists."), with Close (Esc) to leave it.
 */
export function EmptyWindow({ gone }: { gone?: string | false | null }) {
  return (
    <div className="editor">
      <div className="editor-body">
        <EmptyState>{gone || 'Loading…'}</EmptyState>
      </div>
      <WindowActions close />
    </div>
  );
}
