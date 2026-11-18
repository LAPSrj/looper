import type { ReactNode } from 'react';
import type { Harness, Task, TaskFolder } from '@shared/types';
import { folderTree } from '@shared/folders';
import { lineToEnv, tokenize } from '@shared/cmdline';
import { CheckboxField, Field, FormGroup, InputRow, NumberField, StepFields, TextArea, TextInput } from './ui';
import { WindowActions } from './WindowActions';
import { rid } from '../rid';

/** A new environment's harness, and the one Add Harness starts from. */
export function newHarness(): Harness {
  return { id: `h-${rid()}`, name: 'Claude Code', kind: 'claude-code', command: 'claude', args: [], env: {} };
}

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
  children,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  onBrowse: () => void;
  disabled?: boolean;
  code?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  children?: ReactNode;
}) {
  return (
    <Field label={label}>
      <InputRow>
        <TextInput
          code={code}
          placeholder={placeholder}
          autoFocus={autoFocus}
          disabled={disabled}
          readOnly={!onChange}
          value={value}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
        />
        <button className="btn" disabled={disabled} onClick={onBrowse}>
          Browse…
        </button>
        {children}
      </InputRow>
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

/** The note a guidance window saves (none for an empty text), or why it can't. */
export function guidanceNote(text: string, runsLeft: number): { note: Task['note'] } | { problem: string } {
  const trimmed = text.trim();
  if (!trimmed) return { note: undefined };
  if (!Number.isInteger(runsLeft) || runsLeft < 1) return { problem: 'Applies to next: must be a whole number of runs, at least 1.' };
  return { note: { text: trimmed, runsLeft } };
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
