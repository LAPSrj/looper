import { useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
      {help && <p className="help">{help}</p>}
    </div>
  );
}

interface NumberInputProps {
  suffix: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
}

export function NumberInput({ suffix, value, onChange, min, max, disabled }: NumberInputProps) {
  return (
    <div className="input-suffix">
      <input
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="suffix">{suffix}</span>
    </div>
  );
}

export function NumberField({ label, ...rest }: { label: string } & NumberInputProps) {
  return (
    <Field label={label}>
      <NumberInput {...rest} />
    </Field>
  );
}

export function TabBar<T extends string>({
  tabs,
  active,
  onSelect,
  className,
}: {
  tabs: readonly (readonly [T, string])[];
  active: T;
  onSelect: (id: T) => void;
  className?: string;
}) {
  return (
    <nav className={`tabs${className ? ` ${className}` : ''}`}>
      {tabs.map(([id, label]) => (
        <button key={id} className={`tab ${active === id ? 'active' : ''}`} onClick={() => onSelect(id)}>
          {label}
        </button>
      ))}
    </nav>
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

/** Standard dialog footer: Save | Cancel | Apply. */
export function EditorFooter({ primaryLabel = 'Save', onPrimary, onCancel, onApply, applyLabel = 'Apply', saving, primaryDisabled }: EditorFooterProps) {
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
