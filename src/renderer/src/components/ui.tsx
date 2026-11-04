import { useId, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
// On a phone, marks the window's page and keeps the keyboard and safe-area insets its styles use.
import './phone/keyboard';
import { platform } from '../platform';
import { isPhone } from '../web/page-nav';
import { NavBar } from './NavBar';
import { bindField } from './field-model';
import { ICON_STROKE_BOLD, StatusGlyph } from './icons';
import { Group, Row } from './phone/PhoneList';
import { Tabs } from './Tabs';
import { WindowActions } from './WindowActions';

const onIos = isPhone && platform === 'ios';

/** A check box with its text after it. */
export function CheckboxField({
  label,
  checked,
  onChange,
  disabled,
  autoFocus,
  indeterminate,
  className,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Partly checked: some of the things it stands for are on. */
  indeterminate?: boolean;
  className?: string;
}) {
  return (
    <label className={`checkbox-field${className ? ` ${className}` : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        autoFocus={autoFocus}
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
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const chosen = Math.max(0, options.findIndex(([v]) => v === value));
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const to = (chosen + step + options.length) % options.length;
    onChange(options[to][0]);
    refs.current[to]?.focus();
  };
  return (
    <div className="radio-field radio-rows">
      {!hideLabel && <span className="field-label">{label}</span>}
      <div className="radio-rows-list" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
        {options.map(([v, text], i) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} tabIndex={i === chosen ? 0 : -1} className="radio-row" ref={(el) => void (refs.current[i] = el)} onClick={() => onChange(v)}>
            <span>{text}</span>
            {value === v && (
              <svg className="radio-row-check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={ICON_STROKE_BOLD} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m2 7.5 3.2 3.2L12 3.5" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A WinUI InfoBar at its informational severity: a status that needs the
 * user, shown inline until it's resolved, with no close button. `stacked`
 * puts the title on its own line, as WinUI does when the text doesn't fit one.
 */
export function InfoBar({
  title,
  message,
  action,
  stacked,
}: {
  title: string;
  message: ReactNode;
  action?: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={`infobar${stacked ? ' infobar-stacked' : ''}`} role="status">
      <StatusGlyph level="info" />
      <div className="infobar-text">
        <span className="infobar-title">{title}</span>
        <span className="infobar-message">{message}</span>
        {action && <span className="infobar-action">{action}</span>}
      </div>
    </div>
  );
}

/** A label and its control, tied together so the control is named by the label (and a click on the label focuses it). */
export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  const id = useId();
  const labelId = `${id}-label`;
  const bound = bindField(children, id);
  return (
    <div className="field" role={bound.group ? 'group' : undefined} aria-labelledby={bound.group ? labelId : undefined}>
      <label id={labelId} className="field-label" htmlFor={bound.controlId}>
        {label}
      </label>
      {bound.children}
      {help && <p className="help">{help}</p>}
    </div>
  );
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
  /** Fired when focus leaves the input; the place to normalize against other fields. */
  onBlur?: () => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  /** A class on the box's wrapper, for a box outside a form (the image window's zoom). */
  className?: string;
}

export function NumberInput({ suffix, value, onChange, onBlur, min, max, disabled, autoFocus, id, label, className }: NumberInputProps) {
  return (
    <InputSuffix suffix={suffix} className={className}>
      <input
        id={id}
        aria-label={label}
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        autoFocus={autoFocus}
        value={value ?? ''}
        onChange={(e) => {
          // A cleared field is a keystroke on the way to a new number, not a 0.
          if (e.target.value === '') return;
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        onBlur={onBlur}
      />
    </InputSuffix>
  );
}

/**
 * The fields that depend on a checkbox right above them: indented under it, and dimmed and disabled (not hidden) while it's off.
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

/**
 * A window's tabs (a thin wrapper over Tabs). With `sections`, the tabs'
 * panel is the TabBar's `children`: an iPhone shows the sections as a list of
 * rows and a section's panel in a screen of its own, which Back leaves; every
 * other platform shows the tabs with the panel below.
 */
export function TabBar<T extends string>({
  tabs,
  active,
  onSelect,
  className,
  label = 'Sections',
  sections,
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
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rows = onIos && !!sections;
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
  const segmented = onIos && !sections && tabs.length <= SEGMENTS;
  return (
    <>
      <Tabs
        tabs={tabs.map(([id, text]) => ({ id, label: text }))}
        active={active}
        onSelect={(id) => onSelect(id as T)}
        label={label}
        ctrlTab={ctrlTab}
        className={`${segmented ? 'tabs-segmented ' : ''}${className ?? ''}`.trim() || undefined}
      />
      {children}
    </>
  );
}

export interface TableCol {
  label: string;
  /** Starting width in px; omit for the flex column that takes the remaining space. */
  width?: number;
  min?: number;
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
          <col key={i} style={widths[i] !== undefined ? { width: widths[i] } : undefined} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={i}>
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
        <div className="empty">{gone || 'Loading…'}</div>
      </div>
      <WindowActions close />
    </div>
  );
}
