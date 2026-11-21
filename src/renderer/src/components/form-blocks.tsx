import type { ReactNode } from 'react';
import type { TaskFolder } from '@shared/types';
import { folderTree } from '@shared/folders';
import { lineToEnv, tokenize } from '@shared/cmdline';
import { CheckboxField, Field, FieldError, FormGroup, InputRow, NumberField, onIos, StepFields, TextArea, TextInput } from './ui';
import { Icon } from './Icon';
import { WindowActions } from './WindowActions';
import { isPhone } from '../web/page-nav';

/** Arguments and environment variables as typed, as tokens and a map; or the first problem, after its field's label. */
export function parseArgsEnv(
  args: { label: string; text: string },
  env: { label: string; text: string },
): { args: string[]; env: Record<string, string> } | { problem: string } {
  const tokens = tokenize(args.text);
  if (!tokens.ok) return { problem: `${args.label}: ${tokens.error}` };
  const vars = lineToEnv(env.text);
  if (typeof vars === 'string') return { problem: `${env.label}: ${vars}` };
  return { args: tokens.tokens, env: vars };
}

/** A path and Browse… after it (and the field's own buttons, Reset). Without `onChange` the path is only shown. */
export function PathField({
  label,
  value,
  onChange,
  onBrowse,
  disabled,
  code,
  placeholder,
  autoFocus,
  error,
  children,
}: {
  label: string;
  value: string;
  /** A problem with the path: under it (Field's in-place error). */
  error?: string;
  onChange?: (value: string) => void;
  onBrowse: () => void;
  disabled?: boolean;
  code?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  children?: ReactNode;
}) {
  // A phone picks the file instead of typing it, and shows only its name (a file from the phone has a path in Looper's uploads).
  const name = value.split(/[\\/]/).filter(Boolean).pop() ?? value;
  // An iPhone picks a path as Settings picks a value: the whole row opens the picker, the name at its end (ios.md: Lists).
  if (onIos) {
    return (
      <>
        <button type="button" className="field path-row" disabled={disabled} autoFocus={autoFocus} onClick={onBrowse}>
          <span className="field-label">{label}</span>
          <span className={`path-row-value${value ? '' : ' empty'}${code ? ' mono' : ''}`}>{name || placeholder || 'Not Set'}</span>
        </button>
        {error && <FieldError>{error}</FieldError>}
        {children}
      </>
    );
  }
  const input = isPhone ? (
    <TextInput code={code} placeholder={placeholder} disabled={disabled} readOnly value={name} onClick={onBrowse} />
  ) : (
    <TextInput
      code={code}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      readOnly={!onChange}
      value={value}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
    />
  );
  return (
    <Field label={label} error={error}>
      {isPhone ? (
        // Android: Material's text field with a trailing icon button.
        <InputRow className="path-input">
          {input}
          <button type="button" className="path-browse" aria-label="Browse" disabled={disabled} onClick={onBrowse}>
            <Icon name="openFolder" size={24} box={16} />
          </button>
          {children}
        </InputRow>
      ) : (
        <InputRow>
          {input}
          <button className="btn" disabled={disabled} onClick={onBrowse}>
            Browse…
          </button>
          {children}
        </InputRow>
      )}
    </Field>
  );
}

/** The folders as a flat list in tree order, each name indented by its depth (a no-break space, which a drop-down keeps). */
export const folderChoices = (folders: TaskFolder[]): { id: string; name: string }[] =>
  folderTree(folders).map(({ folder, depth }) => ({ id: folder.id, name: ' '.repeat(depth * 3) + folder.name }));

/** A folder drop-down's options after its own first one (Top level, Leave them where they are). */
export function FolderOptions({ folders }: { folders: TaskFolder[] }) {
  return (
    <>
      {folderChoices(folders).map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </>
  );
}

/** "Limit concurrent tasks" and, under it, how many: an environment's or a harness's. Undefined = no limit. */
export function ConcurrencyLimit({ value, onChange }: { value: number | undefined; onChange: (max: number | undefined) => void }) {
  return (
    <FormGroup>
      <CheckboxField label="Limit concurrent tasks" checked={value !== undefined} onChange={(on) => onChange(on ? 1 : undefined)} />
      <StepFields on={value !== undefined}>
        <NumberField label="Maximum concurrent tasks" suffix="tasks" min={1} value={value ?? 1} onChange={onChange} />
      </StepFields>
    </FormGroup>
  );
}

/** A guidance window: the text for the next runs and how many runs it applies to (a task's, or every task's in a folder). */
export function GuidanceForm({
  label = 'Guidance',
  text,
  onText,
  runsLeft,
  onRunsLeft,
  saving,
  onSave,
}: {
  label?: string;
  text: string;
  onText: (text: string) => void;
  runsLeft: number;
  onRunsLeft: (n: number) => void;
  saving: boolean;
  onSave: () => void;
}) {
  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label={label}>
              <TextArea autoFocus rows={7} value={text} onChange={(e) => onText(e.target.value)} />
            </Field>
            <NumberField label="Applies to next" suffix="runs" min={1} value={runsLeft} onChange={onRunsLeft} />
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Save', run: onSave }} busy={saving} />
    </div>
  );
}
