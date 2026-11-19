import { Children, cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, ComponentProps, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react';
// On a phone, marks the window's page and keeps the keyboard and safe-area insets its styles use.
import './phone/keyboard';
import { platform } from '../platform';
import { isPhone } from '../web/page-nav';
import { EmptyState } from './EmptyState';
import { NavBar } from './NavBar';
import { bindField, textOptions, type TextOptions } from './field-model';
import { StatusGlyph, type StatusLevel } from './icons';
import { Group, Row, Segmented } from './phone/PhoneList';
import { Tabs } from './Tabs';
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
export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  const id = useId();
  const labelId = `${id}-label`;
  const bound = bindField(children, id);
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

/**
 * iOS's pop-up button: the chosen option as ordinary text that wraps at the row's end, with the up-and-down
 * chevrons. The select lies over it, unseen, so a tap opens the system's own menu (a select can't wrap its text).
 */
function IosPopUp({ onChange, ...rest }: ComponentProps<'select'>) {
  const ref = useRef<HTMLSelectElement>(null);
  const [text, setText] = useState('');
  const sync = () => setText(ref.current?.selectedOptions[0]?.text.trim() ?? '');
  useLayoutEffect(sync);
  return (
    <span className={`select-control${rest.disabled ? ' disabled' : ''}`}>
      <span className="select-value" aria-hidden="true">
        {text}
      </span>
      <select
        ref={ref}
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
 * A row of buttons that each turn one choice on or off (days of the week, effort levels); one always stays on.
 * `wrap`: many short buttons (days of the month) that wrap onto more lines.
 */
export function ToggleButtons<T extends string | number>({
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
    <div className={wrap ? 'dom-row' : 'day-row'} role="group" aria-label={label}>
      {options.map(([v, text]) => {
        const on = value.includes(v);
        return (
          <button
            key={v}
            aria-pressed={on}
            className={`btn small day-toggle${on ? ' selected' : ''}`}
            onClick={() => {
              const next = on ? value.filter((x) => x !== v) : [...value, v];
              if (next.length > 0) onChange(next);
            }}
          >
            {text}
          </button>
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

/** Up to this many tabs, an iPhone draws them as a segmented control. */
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
 */
export function TabBar<T extends string>({
  tabs,
  active,
  onSelect,
  className,
  label = 'Sections',
  sections,
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
  panels?: (id: T) => ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rows = isPhone && !!sections;
  const close = () => setOpen(false);
  if (rows) {
    if (open) {
      return (
        <>
          <NavBar title={tabs.find(([id]) => id === active)?.[1]} back={close} order={3} />
          {children}
        </>
      );
    }
    return (
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
  return (
    <>
      {onIos && !sections && tabs.length <= SEGMENTS ? (
        <Segmented items={tabs} value={active} onChange={onSelect} label={label} ctrlTab={ctrlTab} className={`pg-segmented tabs-segmented${className ? ` ${className}` : ''}`} />
      ) : (
        <Tabs tabs={tabs.map(([id, text]) => ({ id, label: text }))} active={active} onSelect={(id) => onSelect(id as T)} label={label} ctrlTab={ctrlTab} className={className} />
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

/** Stored widths keyed by column label, so entries survive column reorder/insertion. */
function loadStoredWidths(storageKey: string | undefined, cols: readonly TableCol[]): (number | undefined)[] {
  const defaults = cols.map((c) => c.width);
  if (!storageKey) return defaults;
  try {
    const raw = localStorage.getItem(`col-widths:${storageKey}`);
    if (!raw) return defaults;
    const stored: unknown = JSON.parse(raw);
    if (stored === null || typeof stored !== 'object') return defaults;
    return cols.map((c, i) => {
      if (c.width === undefined) return undefined;
      const w = (stored as Record<string, unknown>)[c.label];
      return typeof w === 'number' && Number.isFinite(w) ? Math.max(c.min ?? 40, Math.round(w)) : defaults[i];
    });
  } catch {
    return defaults;
  }
}

/**
 * Colgroup + header row for a fixed-layout table, with per-column drag-resize.
 * Drop it directly inside a `<table>`, before the tbody. With a `storageKey`,
 * widths persist in localStorage (saved on drag end, only where they differ
 * from the defaults); double-clicking a handle resets its column.
 */
export function ResizableColumns({ cols, storageKey }: { cols: readonly TableCol[]; storageKey?: string }) {
  const [widths, setWidths] = useState<(number | undefined)[]>(() => loadStoredWidths(storageKey, cols));
  const widthsRef = useRef(widths);
  widthsRef.current = widths;

  const save = (w: readonly (number | undefined)[]) => {
    if (!storageKey) return;
    try {
      const stored: Record<string, number> = {};
      cols.forEach((c, i) => {
        if (c.width !== undefined && typeof w[i] === 'number' && w[i] !== c.width) stored[c.label] = w[i]!;
      });
      localStorage.setItem(`col-widths:${storageKey}`, JSON.stringify(stored));
    } catch {
      /* storage unavailable: widths just don't persist */
    }
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
