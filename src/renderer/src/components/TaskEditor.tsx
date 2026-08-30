import { useEffect, useState, type ReactNode } from 'react';
import type { Target, Task, TaskInput } from '@shared/types';
import { slugify, validateTask } from '@shared/validate';
import { EXAMPLE_TASK } from '@shared/example-task';

interface Props {
  task: Task | null;
  /** Preselected environment for new tasks (from global settings). */
  defaultTarget?: Target;
  onSaved: (task: Task) => void;
  onCancel: () => void;
}

type Draft = TaskInput & {
  agent: NonNullable<TaskInput['agent']>;
  check: NonNullable<TaskInput['check']>;
};

function blankDraft(defaultTarget?: Target): Draft {
  return {
    ...EXAMPLE_TASK,
    id: '',
    name: '',
    cwd: '',
    target: defaultTarget ?? { kind: 'wsl' },
    check: { command: '', timeoutSec: 60 },
    classifier: undefined,
    agent: { ...EXAMPLE_TASK.agent, prompt: '' },
  } as Draft;
}

function toDraft(t: Task): Draft {
  return JSON.parse(JSON.stringify(t)) as Draft;
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
      {help && <p className="help">{help}</p>}
    </div>
  );
}

const PERMISSION_MODES: [string, string][] = [
  ['auto', 'Auto — approve routine actions (default)'],
  ['acceptEdits', 'Accept edits — auto-approve file edits'],
  ['manual', 'Manual — ask for everything'],
  ['dontAsk', "Don't ask"],
  ['plan', 'Plan mode'],
  ['bypassPermissions', 'Bypass — approve everything (dangerous)'],
  ['', "None — use claude's own default"],
];

export function TaskEditor({ task, defaultTarget, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<Draft>(() => (task ? toDraft(task) : blankDraft(defaultTarget)));
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [extraArgsText, setExtraArgsText] = useState((task?.agent.extraArgs ?? []).join('\n'));

  useEffect(() => {
    if (jsonMode) setJsonText(JSON.stringify(assemble(), null, 2));
  }, [jsonMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleKind = 'cron' in draft.schedule ? 'cron' : 'every';
  const scheduleValue = 'cron' in draft.schedule ? draft.schedule.cron : draft.schedule.every;
  const isWsl = draft.target.kind === 'wsl';
  const wslTarget = isWsl ? (draft.target as { kind: 'wsl'; distro?: string; shell?: string }) : null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setAgent = <K extends keyof Draft['agent']>(key: K, value: Draft['agent'][K]) =>
    setDraft((d) => ({ ...d, agent: { ...d.agent, [key]: value } }));
  const setCheck = <K extends keyof Draft['check']>(key: K, value: Draft['check'][K]) =>
    setDraft((d) => ({ ...d, check: { ...d.check, [key]: value } }));
  const setWsl = (patch: { distro?: string; shell?: string }) =>
    set('target', { kind: 'wsl', distro: wslTarget?.distro, shell: wslTarget?.shell, ...patch });

  function assemble(): Record<string, unknown> {
    return {
      ...draft,
      id: draft.id?.trim() || (draft.name ? slugify(draft.name) : ''),
      agent: {
        ...draft.agent,
        extraArgs: extraArgsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      },
    };
  }

  const save = async () => {
    let obj: Record<string, unknown>;
    if (jsonMode) {
      try {
        obj = JSON.parse(jsonText) as Record<string, unknown>;
      } catch (e) {
        setErrors([`JSON: ${(e as Error).message}`]);
        return;
      }
    } else {
      obj = assemble();
    }
    const v = validateTask(obj);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setSaving(true);
    try {
      const saved = await window.looper.tasks.save(v.task);
      setErrors([]);
      onSaved(saved);
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="editor">
      <div className="editor-toolbar">
        <span className="spacer" />
        <label className="inline-check">
          <input type="checkbox" checked={jsonMode} onChange={(e) => setJsonMode(e.target.checked)} /> Edit as JSON
        </label>
        <button className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          {task ? 'Save changes' : 'Create task'}
        </button>
      </div>
      {errors.length > 0 && (
        <ul className="errors">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {jsonMode ? (
        <textarea className="json-editor mono" value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
      ) : (
        <div className="form">
          <section>
            <h3>Basics</h3>
            <Field label="Task name" help="Shown in the task list.">
              <input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Issues triage" />
            </Field>
            <div className="row">
              <Field label="Status" help="Disabled tasks are kept but never run.">
                <select
                  value={draft.enabled === false ? 'disabled' : 'enabled'}
                  onChange={(e) => set('enabled', e.target.value === 'enabled')}
                >
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </Field>
              <Field label="Repeat">
                <select
                  value={scheduleKind}
                  onChange={(e) => set('schedule', e.target.value === 'cron' ? { cron: '*/10 * * * *' } : { every: '10m' })}
                >
                  <option value="every">Fixed interval</option>
                  <option value="cron">Cron schedule</option>
                </select>
              </Field>
              <Field
                label={scheduleKind === 'every' ? 'Interval' : 'Cron expression'}
                help={
                  scheduleKind === 'every'
                    ? 'Counted after each run finishes — e.g. 90s, 5m, 1h30m.'
                    : 'Wall-clock schedule. Slots that pass while a run is busy are skipped, never overlapped.'
                }
              >
                <input
                  className="mono"
                  value={scheduleValue}
                  onChange={(e) => set('schedule', scheduleKind === 'cron' ? { cron: e.target.value } : { every: e.target.value })}
                  placeholder={scheduleKind === 'every' ? '10m' : '*/10 * * * *'}
                />
              </Field>
            </div>
          </section>

          <section>
            <h3>Where it runs</h3>
            <div className="row">
              <Field label="Environment">
                <select
                  value={draft.target.kind}
                  onChange={(e) => set('target', e.target.value === 'windows' ? { kind: 'windows' } : { kind: 'wsl' })}
                >
                  <option value="wsl">WSL / Linux shell</option>
                  <option value="windows">Windows (PowerShell)</option>
                </select>
              </Field>
              {isWsl && (
                <Field label="WSL distro" help="Leave empty to use the default distro.">
                  <input
                    value={wslTarget?.distro ?? ''}
                    onChange={(e) => setWsl({ distro: e.target.value || undefined })}
                    placeholder="Ubuntu-22.04"
                  />
                </Field>
              )}
            </div>
            <Field
              label="Working directory"
              help="Where the check script and the agent run, written the way that environment sees it."
            >
              <input
                className="mono"
                value={draft.cwd}
                onChange={(e) => set('cwd', e.target.value)}
                placeholder={isWsl ? '/home/me/repos/project' : 'C:\\repos\\project'}
              />
            </Field>
          </section>

          <section>
            <h3>Check</h3>
            <Field
              label="Check command"
              help={
                <>
                  A cheap script that decides whether there is anything to do. The last line it prints must be JSON:{' '}
                  <code>{'{"act": true, "summary": "3 new issues", "context": …}'}</code>. A failing or malformed check is an
                  error and never starts an agent.
                </>
              }
            >
              <textarea className="mono" rows={3} value={draft.check.command} onChange={(e) => setCheck('command', e.target.value)} />
            </Field>
          </section>

          <section>
            <h3>Classifier</h3>
            <Field
              label="Classifier step"
              help="A cheap model reads the check output and decides whether starting the full agent is worth it. Useful when the check catches noise."
            >
              <select
                value={draft.classifier ? 'on' : 'off'}
                onChange={(e) => set('classifier', e.target.value === 'on' ? { ...EXAMPLE_TASK.classifier! } : undefined)}
              >
                <option value="off">Off — every positive check starts the agent</option>
                <option value="on">On — a cheap model filters first</option>
              </select>
            </Field>
            {draft.classifier && (
              <>
                <div className="row">
                  <Field label="Model">
                    <input
                      value={draft.classifier.model ?? 'haiku'}
                      onChange={(e) => set('classifier', { ...draft.classifier!, model: e.target.value })}
                    />
                  </Field>
                  <Field label="Budget limit (USD)">
                    <input
                      type="number"
                      min={0.01}
                      step={0.01}
                      value={draft.classifier.maxBudgetUsd ?? 0.1}
                      onChange={(e) => set('classifier', { ...draft.classifier!, maxBudgetUsd: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Timeout (seconds)">
                    <input
                      type="number"
                      min={1}
                      value={draft.classifier.timeoutSec ?? 180}
                      onChange={(e) => set('classifier', { ...draft.classifier!, timeoutSec: Number(e.target.value) })}
                    />
                  </Field>
                </div>
                <Field
                  label="Classifier prompt"
                  help={
                    <>
                      Ask a yes/no question about the check output. <code>{'{{summary}}'}</code> and <code>{'{{context}}'}</code>{' '}
                      insert it; if you don't use them it is appended automatically.
                    </>
                  }
                >
                  <textarea rows={4} value={draft.classifier.prompt} onChange={(e) => set('classifier', { ...draft.classifier!, prompt: e.target.value })} />
                </Field>
              </>
            )}
          </section>

          <section>
            <h3>Agent</h3>
            <div className="row">
              <Field label="Model" help="e.g. sonnet, opus, haiku. Empty = your claude default.">
                <input value={draft.agent.model ?? ''} onChange={(e) => setAgent('model', e.target.value || undefined)} placeholder="sonnet" />
              </Field>
              <Field
                label="Session type"
                help={
                  draft.agent.mode === 'headless'
                    ? 'Runs claude -p with no interaction; the run ends when the process exits.'
                    : 'Runs in a visible terminal you can type into; the agent ends the run with looper-done.'
                }
              >
                <select value={draft.agent.mode ?? 'interactive'} onChange={(e) => setAgent('mode', e.target.value as 'interactive' | 'headless')}>
                  <option value="interactive">Interactive terminal (default)</option>
                  <option value="headless">Headless (claude -p)</option>
                </select>
              </Field>
            </div>
            <Field
              label="Agent prompt"
              help={
                <>
                  What the agent should do. <code>{'{{summary}}'}</code> and <code>{'{{context}}'}</code> insert the check output
                  (appended automatically if you don't use them). Good practice: end with "finish by running{' '}
                  <code>looper-done "&lt;one line summary&gt;"</code>".
                </>
              }
            >
              <textarea rows={7} value={draft.agent.prompt} onChange={(e) => setAgent('prompt', e.target.value)} />
            </Field>
          </section>

          <details className="advanced">
            <summary>Advanced settings</summary>
            <div className="row">
              <Field label="Task ID" help={task ? 'Fixed after creation.' : 'Leave empty to generate it from the name.'}>
                <input className="mono" value={draft.id} disabled={!!task} onChange={(e) => set('id', e.target.value)} placeholder="issues-triage" />
              </Field>
              {isWsl && (
                <Field label="Shell" help="Launches the check and the agent. The default bash -lic loads your login + interactive profile (nvm, PATH).">
                  <input className="mono" value={wslTarget?.shell ?? ''} onChange={(e) => setWsl({ shell: e.target.value || undefined })} placeholder="bash -lic" />
                </Field>
              )}
            </div>
            <div className="row">
              <Field label="Check timeout (seconds)">
                <input type="number" min={1} value={draft.check.timeoutSec ?? 60} onChange={(e) => setCheck('timeoutSec', Number(e.target.value))} />
              </Field>
              <Field label="Permission mode" help="Passed to claude as --permission-mode.">
                <select value={draft.agent.permissionMode ?? 'auto'} onChange={(e) => setAgent('permissionMode', e.target.value)}>
                  {PERMISSION_MODES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Extra claude arguments" help="One per line, appended to the claude command line as-is.">
              <textarea className="mono" rows={3} value={extraArgsText} onChange={(e) => setExtraArgsText(e.target.value)} placeholder={'--add-dir\n/home/me/other-repo'} />
            </Field>
            <div className="row">
              <Field label="Max runtime (minutes)" help="Hard stop for a single agent run.">
                <input type="number" min={1} value={draft.agent.maxRuntimeMin ?? 120} onChange={(e) => setAgent('maxRuntimeMin', Number(e.target.value))} />
              </Field>
              <Field label="Idle grace (minutes)" help="How long the agent may sit idle — turn finished, or waiting on a prompt — without signalling done.">
                <input type="number" min={1} value={draft.agent.idleGraceMin ?? 3} onChange={(e) => setAgent('idleGraceMin', Number(e.target.value))} />
              </Field>
              <Field label="When idle too long">
                <select value={draft.agent.onIdleTimeout ?? 'finish'} onChange={(e) => setAgent('onIdleTimeout', e.target.value as 'finish' | 'hold')}>
                  <option value="finish">End the run</option>
                  <option value="hold">Hold and wait for me</option>
                </select>
              </Field>
              <Field label="Auto-pause after" help="Consecutive failed cycles before the task pauses itself.">
                <input
                  type="number"
                  min={1}
                  value={draft.backoff?.maxConsecutiveErrors ?? 5}
                  onChange={(e) => set('backoff', { maxConsecutiveErrors: Number(e.target.value) })}
                />
              </Field>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
