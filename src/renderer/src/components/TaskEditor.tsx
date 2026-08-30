import { useEffect, useMemo, useState } from 'react';
import type { Task, TaskInput } from '@shared/types';
import { validateTask } from '@shared/validate';
import { EXAMPLE_TASK } from '@shared/example-task';

interface Props {
  task: Task | null;
  onSaved: (task: Task) => void;
  onCancel: () => void;
}

type Draft = TaskInput & {
  agent: NonNullable<TaskInput['agent']>;
  check: NonNullable<TaskInput['check']>;
};

function blankDraft(): Draft {
  return {
    ...EXAMPLE_TASK,
    id: '',
    name: '',
    cwd: '',
    check: { command: '', timeoutSec: 60 },
    classifier: undefined,
    agent: { ...EXAMPLE_TASK.agent, prompt: '' },
  } as Draft;
}

function toDraft(t: Task): Draft {
  return JSON.parse(JSON.stringify(t)) as Draft;
}

export function TaskEditor({ task, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<Draft>(() => (task ? toDraft(task) : blankDraft()));
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [extraArgsText, setExtraArgsText] = useState((task?.agent.extraArgs ?? []).join('\n'));

  useEffect(() => {
    if (jsonMode) setJsonText(JSON.stringify(draft, null, 2));
  }, [jsonMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleKind = 'cron' in draft.schedule ? 'cron' : 'every';
  const scheduleValue = 'cron' in draft.schedule ? draft.schedule.cron : draft.schedule.every;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setAgent = <K extends keyof Draft['agent']>(key: K, value: Draft['agent'][K]) =>
    setDraft((d) => ({ ...d, agent: { ...d.agent, [key]: value } }));
  const setCheck = <K extends keyof Draft['check']>(key: K, value: Draft['check'][K]) =>
    setDraft((d) => ({ ...d, check: { ...d.check, [key]: value } }));

  const current = useMemo((): unknown => {
    if (jsonMode) {
      try {
        return JSON.parse(jsonText);
      } catch (e) {
        return { __parseError: (e as Error).message };
      }
    }
    return {
      ...draft,
      agent: {
        ...draft.agent,
        extraArgs: extraArgsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      },
    };
  }, [jsonMode, jsonText, draft, extraArgsText]);

  const save = async () => {
    const obj = current as Record<string, unknown>;
    if (obj.__parseError) {
      setErrors([`JSON: ${String(obj.__parseError)}`]);
      return;
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
        <span className="muted">{task ? `editing ${task.id}` : 'new task'}</span>
        <label>
          <input type="checkbox" checked={jsonMode} onChange={(e) => setJsonMode(e.target.checked)} /> edit as JSON
        </label>
        <span className="spacer" />
        <button className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          Save
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
          <fieldset>
            <legend>Task</legend>
            <label>
              id <span className="hint">letters, digits, - _ (fixed after creation)</span>
              <input value={draft.id} disabled={!!task} onChange={(e) => set('id', e.target.value)} placeholder="issues-triage" />
            </label>
            <label>
              name
              <input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Issues triage" />
            </label>
            <label className="inline">
              <input type="checkbox" checked={draft.enabled ?? true} onChange={(e) => set('enabled', e.target.checked)} /> enabled
            </label>
            <div className="row">
              <label>
                schedule
                <select
                  value={scheduleKind}
                  onChange={(e) =>
                    set('schedule', e.target.value === 'cron' ? { cron: '*/10 * * * *' } : { every: '10m' })
                  }
                >
                  <option value="every">every (interval after each cycle)</option>
                  <option value="cron">cron (wall clock; busy slots are skipped)</option>
                </select>
              </label>
              <label>
                {scheduleKind === 'every' ? 'interval (e.g. 5m, 1h30m)' : 'cron expression'}
                <input
                  value={scheduleValue}
                  onChange={(e) =>
                    set('schedule', scheduleKind === 'cron' ? { cron: e.target.value } : { every: e.target.value })
                  }
                />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Where</legend>
            <div className="row">
              <label>
                target
                <select
                  value={draft.target.kind}
                  onChange={(e) => set('target', e.target.value === 'windows' ? { kind: 'windows' } : { kind: 'wsl' })}
                >
                  <option value="wsl">WSL / Linux shell</option>
                  <option value="windows">Windows (PowerShell)</option>
                </select>
              </label>
              {draft.target.kind === 'wsl' && (
                <>
                  <label>
                    distro <span className="hint">blank = default</span>
                    <input
                      value={draft.target.distro ?? ''}
                      onChange={(e) => set('target', { kind: 'wsl', distro: e.target.value || undefined, shell: draft.target.kind === 'wsl' ? draft.target.shell : undefined })}
                      placeholder="Ubuntu"
                    />
                  </label>
                  <label>
                    shell <span className="hint">default bash -lic</span>
                    <input
                      value={draft.target.shell ?? ''}
                      onChange={(e) => set('target', { kind: 'wsl', distro: draft.target.kind === 'wsl' ? draft.target.distro : undefined, shell: e.target.value || undefined })}
                      placeholder="bash -lic"
                    />
                  </label>
                </>
              )}
            </div>
            <label>
              working directory <span className="hint">as the target sees it</span>
              <input
                className="mono"
                value={draft.cwd}
                onChange={(e) => set('cwd', e.target.value)}
                placeholder={draft.target.kind === 'windows' ? 'C:\\repos\\project' : '/home/me/repos/project'}
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Check</legend>
            <label>
              command <span className="hint">last stdout line must be JSON: {'{"act": true, "summary": "…", "context": …}'}</span>
              <textarea className="mono" rows={3} value={draft.check.command} onChange={(e) => setCheck('command', e.target.value)} />
            </label>
            <label className="short">
              timeout (s)
              <input type="number" min={1} value={draft.check.timeoutSec ?? 60} onChange={(e) => setCheck('timeoutSec', Number(e.target.value))} />
            </label>
          </fieldset>

          <fieldset>
            <legend>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={!!draft.classifier}
                  onChange={(e) =>
                    set('classifier', e.target.checked ? { ...EXAMPLE_TASK.classifier!, prompt: EXAMPLE_TASK.classifier!.prompt } : undefined)
                  }
                />{' '}
                Classifier (cheap model decides whether to start the agent)
              </label>
            </legend>
            {draft.classifier && (
              <>
                <div className="row">
                  <label className="short">
                    model
                    <input value={draft.classifier.model ?? 'haiku'} onChange={(e) => set('classifier', { ...draft.classifier!, model: e.target.value })} />
                  </label>
                  <label className="short">
                    timeout (s)
                    <input type="number" min={1} value={draft.classifier.timeoutSec ?? 180} onChange={(e) => set('classifier', { ...draft.classifier!, timeoutSec: Number(e.target.value) })} />
                  </label>
                  <label className="short">
                    max budget (USD)
                    <input type="number" min={0.01} step={0.01} value={draft.classifier.maxBudgetUsd ?? 0.1} onChange={(e) => set('classifier', { ...draft.classifier!, maxBudgetUsd: Number(e.target.value) })} />
                  </label>
                </div>
                <label>
                  prompt <span className="hint">{'{{summary}}'} and {'{{context}}'} are available; appended automatically if absent</span>
                  <textarea rows={5} value={draft.classifier.prompt} onChange={(e) => set('classifier', { ...draft.classifier!, prompt: e.target.value })} />
                </label>
              </>
            )}
          </fieldset>

          <fieldset>
            <legend>Agent</legend>
            <div className="row">
              <label className="short">
                model <span className="hint">blank = claude default</span>
                <input value={draft.agent.model ?? ''} onChange={(e) => setAgent('model', e.target.value || undefined)} placeholder="sonnet" />
              </label>
              <label className="short">
                mode
                <select value={draft.agent.mode ?? 'interactive'} onChange={(e) => setAgent('mode', e.target.value as 'interactive' | 'headless')}>
                  <option value="interactive">interactive (terminal, looper-done signal)</option>
                  <option value="headless">headless (claude -p, exit = done)</option>
                </select>
              </label>
              <label className="short">
                permission mode <span className="hint">blank = omit flag</span>
                <input value={draft.agent.permissionMode ?? 'auto'} onChange={(e) => setAgent('permissionMode', e.target.value)} placeholder="auto" />
              </label>
            </div>
            <label>
              prompt <span className="hint">{'{{summary}}'}, {'{{context}}'}, {'{{task}}'} available; check output appended if not referenced</span>
              <textarea rows={8} value={draft.agent.prompt} onChange={(e) => setAgent('prompt', e.target.value)} />
            </label>
            <label>
              extra claude arguments <span className="hint">one per line, appended verbatim</span>
              <textarea className="mono" rows={3} value={extraArgsText} onChange={(e) => setExtraArgsText(e.target.value)} placeholder={'--add-dir\n/home/me/other'} />
            </label>
            <div className="row">
              <label className="short">
                max runtime (min)
                <input type="number" min={1} value={draft.agent.maxRuntimeMin ?? 120} onChange={(e) => setAgent('maxRuntimeMin', Number(e.target.value))} />
              </label>
              <label className="short">
                idle grace (min)
                <input type="number" min={1} value={draft.agent.idleGraceMin ?? 3} onChange={(e) => setAgent('idleGraceMin', Number(e.target.value))} />
              </label>
              <label className="short">
                on idle timeout
                <select value={draft.agent.onIdleTimeout ?? 'finish'} onChange={(e) => setAgent('onIdleTimeout', e.target.value as 'finish' | 'hold')}>
                  <option value="finish">finish the run</option>
                  <option value="hold">hold for a human</option>
                </select>
              </label>
              <label className="short">
                auto-pause after N errors
                <input
                  type="number"
                  min={1}
                  value={draft.backoff?.maxConsecutiveErrors ?? 5}
                  onChange={(e) => set('backoff', { maxConsecutiveErrors: Number(e.target.value) })}
                />
              </label>
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}
