import { useId, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
// On a phone, marks the window's page and keeps the keyboard and safe-area insets its styles use.
import './phone/keyboard';
import { platform } from '../platform';
import { isPhone, usePageNav } from '../web/page-nav';
import { bindField } from './field-model';
import { ICON_STROKE_BOLD, StatusGlyph } from './icons';
import { Group, Row } from './phone/PhoneList';
import { Tabs } from './Tabs';

const onIos = isPhone && platform === 'ios';

/** A labelled group of radio buttons, one per option, stacked vertically; on an iPhone, rows with a check on the chosen one. */
export function RadioField<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  if (onIos) return <CheckRows label={label} value={value} options={options} onChange={onChange} />;
  return (
    <div className="radio-field" role="radiogroup" aria-label={label}>
      <span className="field-label">{label}</span>
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
function CheckRows<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
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
      <span className="field-label">{label}</span>
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

interface NumberInputProps {
  /** The unit, inside the box at its right edge; omit for a plain number (a port). */
  suffix?: string;
  value: number;
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
}

export function NumberInput({ suffix, value, onChange, onBlur, min, max, disabled, id, label }: NumberInputProps) {
  return (
    <div className="input-suffix">
      <input
        id={id}
        aria-label={label}
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          // A cleared field is a keystroke on the way to a new number, not a 0.
          if (e.target.value === '') return;
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        onBlur={onBlur}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

/** The fields that depend on a checkbox right above them: indented under it, and dimmed and disabled (not hidden) while it's off. */
export function StepFields({ on, when = true, children }: { on: boolean; /** False: the fields have no checkbox above them (no project), and show as they are. */ when?: boolean; children: ReactNode }) {
  if (!when) return <>{children}</>;
  return (
    <fieldset className={`step-fields step-stack${on ? '' : ' disabled'}`} disabled={!on}>
      {children}
    </fieldset>
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
  usePageNav(rows && open ? { title: tabs.find(([id]) => id === active)?.[1], back: close } : null, 3);
  if (rows) {
    if (open) return <>{children}</>;
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

interface EditorFooterProps {
  primaryLabel?: string;
  onPrimary: () => void;
  onCancel: () => void;
  /** Omit to hide the Apply button. */
  onApply?: () => void;
  applyLabel?: string;
  saving?: boolean;
  primaryDisabled?: boolean;
}

/**
 * Standard dialog footer: Save | Cancel | Apply. A phone draws Cancel and the
 * primary button in its navigation bar instead (PageNav `cancel`/`confirm`),
 * and leaves Apply out.
 */
export function EditorFooter({ primaryLabel = 'Save', onPrimary, onCancel, onApply, applyLabel = 'Apply', saving, primaryDisabled }: EditorFooterProps) {
  usePageNav({ cancel: { disabled: saving, run: onCancel }, confirm: { label: primaryLabel, disabled: saving || primaryDisabled, run: onPrimary } }, 2);
  if (isPhone) return null;
  return (
    <div className="editor-footer">
      <button className="btn primary" onClick={onPrimary} disabled={saving || primaryDisabled}>
        {primaryLabel}
      </button>
      <button className="btn" onClick={onCancel} disabled={saving}>
        Cancel
      </button>
      {onApply && (
        <button className="btn" onClick={onApply} disabled={saving}>
          {applyLabel}
        </button>
      )}
    </div>
  );
}
