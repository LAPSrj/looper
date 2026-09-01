import type { ReactNode } from 'react';

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

interface EditorFooterProps {
  primaryLabel?: string;
  onPrimary: () => void;
  onCancel: () => void;
  /** Omit to hide the Apply button. */
  onApply?: () => void;
  saving?: boolean;
  primaryDisabled?: boolean;
}

/** Standard dialog footer: Save | Cancel | Apply. */
export function EditorFooter({ primaryLabel = 'Save', onPrimary, onCancel, onApply, saving, primaryDisabled }: EditorFooterProps) {
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
          Apply
        </button>
      )}
    </div>
  );
}
