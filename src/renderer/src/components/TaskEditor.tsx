import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Cron } from 'croner';
import type { Environment, Task, TaskInput } from '@shared/types';
import { ALL_DAYS, cronToForm, formToCron, timesExpressible, type CronForm } from '@shared/cron';
import { slugify, validateTask } from '@shared/validate';
import { DEFAULT_MODELS, harnessKindLabel, harnessModels, pathFlavor } from '@shared/environments';
import { joinTokens, tokenize } from '@shared/cmdline';
import { EXAMPLE_TASK } from '@shared/example-task';

interface Props {
  task: Task | null;
  /** Prefill for a NEW task (e.g. the example task); ignored when editing. */
  initial?: TaskInput;
  /** The configured environments (File → Settings → Environments). */
  environments: Environment[];
  /** Environment preselected for new tasks (from global settings). */
  defaultEnvironmentId?: string;
  /** Host kind, deciding the path style of `local` environments. */
  host?: string;
  /** 'template' saves to the template store instead of the task store. */
  mode?: 'task' | 'template';
  onSaved: (task: Task) => void;
  onCancel: () => void;
}

type Draft = TaskInput & {
  agent: NonNullable<TaskInput['agent']>;
  check: NonNullable<TaskInput['check']>;
};

type EditorTab = 'general' | 'trigger' | 'conditions' | 'action' | 'settings' | 'json';

const TABS: [EditorTab, string][] = [
  ['general', 'General'],
  ['trigger', 'Trigger'],
  ['conditions', 'Conditions'],
  ['action', 'Action'],
  ['settings', 'Settings'],
  ['json', 'JSON'],
];

function blankDraft(environmentId?: string): Draft {
  return {
    ...EXAMPLE_TASK,
    id: '',
    name: '',
    cwd: '',
    environmentId: environmentId ?? '',
    check: { command: '', timeoutSec: 60 },
    classifier: undefined,
    agent: { ...EXAMPLE_TASK.agent, prompt: '' },
  } as Draft;
}

function toDraft(t: Task): Draft {
  return JSON.parse(JSON.stringify(t)) as Draft;
}

function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label className="field-label">{label}</label>
      {children}
      {help && <p className="help">{help}</p>}
    </div>
  );
}

const PERMISSION_MODES: [string, string][] = [
  ['auto', 'Auto'],
  ['acceptEdits', 'Accept edits'],
  ['manual', 'Manual'],
  ['dontAsk', "Don't ask"],
  ['plan', 'Plan mode'],
  ['bypassPermissions', 'Bypass'],
  ['', 'None'],
];

export function TaskEditor({ task, initial, environments, defaultEnvironmentId, host, mode = 'task', onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<Draft>(() =>
    task ? toDraft(task) : initial ? (JSON.parse(JSON.stringify(initial)) as Draft) : blankDraft(defaultEnvironmentId),
  );
  const [tab, setTab] = useState<EditorTab>('general');
  const [jsonText, setJsonText] = useState('');
  const [saving, setSaving] = useState(false);
  const [extraArgsText, setExtraArgsText] = useState(() => joinTokens((task ?? initial)?.agent?.extraArgs ?? []));
  // Pins the Model dropdown on "Custom" even while the typed value matches a preset.
  const [customModel, setCustomModel] = useState(false);
  const [customClsModel, setCustomClsModel] = useState(false);

  // Trigger UI: draft.schedule.cron is the single source of truth; the
  // structured controls are a parsed view of it. `customCron` pins the raw
  // input open even when the expression matches a friendly pattern.
  const [customCron, setCustomCron] = useState(false);
  // Daily times must share the hour or the minute; a rejected chip edit shows a hint.
  const [timesWarn, setTimesWarn] = useState(false);
  const cronExpr = draft.schedule.cron;
  const schedForm: CronForm = customCron ? { mode: 'custom', cron: cronExpr } : cronToForm(cronExpr);
  const setSchedule = (f: CronForm) => {
    setTimesWarn(false);
    set('schedule', { cron: formToCron(f) });
  };
  const schedTime =
    'hour' in schedForm
      ? { hour: schedForm.hour, minute: schedForm.minute }
      : schedForm.mode === 'daily'
        ? (schedForm.times[0] ?? { hour: 9, minute: 0 })
        : { hour: 9, minute: 0 };
  const setScheduleMode = (mode: 'every' | CronForm['mode']) => {
    setCustomCron(mode === 'custom');
    setTimesWarn(false);
    if (mode === 'custom' || mode === schedForm.mode) return;
    if (mode === 'every') {
      if (schedForm.mode !== 'minutes' && schedForm.mode !== 'hours') setSchedule({ mode: 'minutes', step: 10 });
    } else if (mode === 'daily') setSchedule({ mode, times: [schedTime] });
    else if (mode === 'weekly') setSchedule({ mode, days: [1], ...schedTime });
    else if (mode === 'monthly') setSchedule({ mode, days: [1], ...schedTime });
  };
  const setDailyTimes = (times: { hour: number; minute: number }[]) => {
    if (timesExpressible(times)) setSchedule({ mode: 'daily', times });
    else setTimesWarn(true);
  };
  const addDailyTime = () => {
    if (schedForm.mode !== 'daily') return;
    const t = schedForm.times;
    const last = t[t.length - 1];
    const candidates = [
      { hour: (last.hour + 1) % 24, minute: last.minute },
      { hour: last.hour, minute: (last.minute + 30) % 60 },
    ];
    for (const c of candidates) {
      const next = [...t, c];
      if (!t.some((x) => x.hour === c.hour && x.minute === c.minute) && timesExpressible(next)) {
        setSchedule({ mode: 'daily', times: next });
        return;
      }
    }
  };
  // Weekday constraint on the Every… modes: undefined = all days.
  const constraintDays = schedForm.mode === 'minutes' || schedForm.mode === 'hours' ? (schedForm.days ?? ALL_DAYS) : [];
  // Unified hours/minutes view for the Every… modes.
  const everyH = schedForm.mode === 'hours' ? schedForm.step : 0;
  const everyM = schedForm.mode === 'hours' ? schedForm.minute : schedForm.mode === 'minutes' ? schedForm.step : 0;
  const toggleConstraintDay = (d: number) => {
    if (schedForm.mode !== 'minutes' && schedForm.mode !== 'hours') return;
    const days = constraintDays.includes(d) ? constraintDays.filter((x) => x !== d) : [...constraintDays, d];
    if (days.length === 0) return;
    setSchedule({ ...schedForm, days: days.length === 7 ? undefined : days });
  };
  let cronNext: string | undefined;
  try {
    cronNext = new Cron(cronExpr).nextRun()?.toLocaleString() ?? undefined;
  } catch {
    /* invalid expression: preview shows an error instead */
  }
  const env = environments.find((e) => e.id === draft.environmentId);
  const harnesses = env?.harnesses ?? [];
  const harness = harnesses.find((h) => h.id === draft.agent.harnessId) ?? harnesses[0];
  const isClaude = (harness?.kind ?? 'claude-code') === 'claude-code';
  const models = harness ? harnessModels(harness) : [];
  // Model presets come from the harness; anything else is edited as "Custom".
  const modelIsCustom = customModel || (!!draft.agent.model && !models.some((m) => m.id === draft.agent.model));

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setAgent = <K extends keyof Draft['agent']>(key: K, value: Draft['agent'][K]) =>
    setDraft((d) => ({ ...d, agent: { ...d.agent, [key]: value } }));
  const setCheck = <K extends keyof Draft['check']>(key: K, value: Draft['check'][K]) =>
    setDraft((d) => ({ ...d, check: { ...d.check, [key]: value } }));
  const browseCwd = async () => {
    const picked = await window.looper.pickDirectory({
      current: draft.cwd || undefined,
      flavor: env ? pathFlavor(env, host) : undefined,
      distro: env?.kind === 'wsl' ? env.distro : undefined,
    });
    if (picked) set('cwd', picked);
  };
  const setEnvironment = (id: string) =>
    setDraft((d) => {
      const next = environments.find((e) => e.id === id);
      const keepHarness = d.agent.harnessId && next?.harnesses.some((h) => h.id === d.agent.harnessId);
      return { ...d, environmentId: id, agent: { ...d.agent, harnessId: keepHarness ? d.agent.harnessId : undefined } };
    });

  /** Throws when the extra-arguments line has unbalanced quotes. */
  function assemble(): Record<string, unknown> {
    const parsedArgs = tokenize(extraArgsText);
    if (!parsedArgs.ok) throw new Error(`extra arguments: ${parsedArgs.error}`);
    return {
      ...draft,
      id: draft.id?.trim() || (draft.name ? slugify(draft.name) : ''),
      agent: {
        ...draft.agent,
        extraArgs: parsedArgs.tokens,
      },
    };
  }

  /** Fold hand-edited JSON back into the form state. Throws on parse errors. */
  function applyJson(text: string): Record<string, unknown> {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const agent = (obj.agent ?? {}) as Record<string, unknown>;
    setDraft(obj as unknown as Draft);
    setExtraArgsText(Array.isArray(agent.extraArgs) ? joinTokens(agent.extraArgs as string[]) : '');
    return obj;
  }

  const switchTab = (next: EditorTab) => {
    if (next === tab) return;
    try {
      if (tab === 'json') applyJson(jsonText);
      if (next === 'json') setJsonText(JSON.stringify(assemble(), null, 2));
    } catch (e) {
      void window.looper.showError(tab === 'json' ? `JSON: ${(e as Error).message}` : (e as Error).message);
      return;
    }
    setTab(next);
  };

  const doSave = async (): Promise<boolean> => {
    let obj: Record<string, unknown>;
    try {
      obj = tab === 'json' ? applyJson(jsonText) : assemble();
    } catch (e) {
      void window.looper.showError(tab === 'json' ? `JSON: ${(e as Error).message}` : (e as Error).message);
      return false;
    }
    const v = validateTask(obj, environments, host);
    if (!v.ok) {
      void window.looper.showError(v.errors.join('\n'));
      return false;
    }
    setSaving(true);
    try {
      if (mode === 'template') await window.looper.templates.save(v.task);
      else await window.looper.tasks.save(v.task);
      return true;
    } catch (e) {
      void window.looper.showError((e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const save = async () => { if (await doSave()) onSaved({} as Task); };
  const apply = async () => { await doSave(); };

  // Dialog keyboard semantics: Esc = cancel, Enter on a single-line input or
  // Ctrl+Enter anywhere = save, Ctrl+Tab / Ctrl+PageDown|PageUp = cycle tabs.
  const keysRef = useRef({ tab, save, onCancel, switchTab });
  keysRef.current = { tab, save, onCancel, switchTab };
  useEffect(() => {
    const order = TABS.map(([id]) => id);
    const onKey = (e: KeyboardEvent) => {
      const k = keysRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        k.onCancel();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        void k.save();
        return;
      }
      const cycle = (dir: number) =>
        k.switchTab(order[(order.indexOf(k.tab) + dir + order.length) % order.length]);
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        cycle(e.shiftKey ? -1 : 1);
      } else if (e.ctrlKey && e.key === 'PageDown') {
        e.preventDefault();
        cycle(1);
      } else if (e.ctrlKey && e.key === 'PageUp') {
        e.preventDefault();
        cycle(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="editor">
      <nav className="tabs editor-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => switchTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="editor-body">
        <div className={`editor-panel${tab !== 'general' ? ' hidden' : ''}`}>
          <div className="form">
            <Field label="Task name">
              <input autoFocus value={draft.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <div className="row">
              <Field label="Status">
                <select
                  value={draft.enabled === false ? 'disabled' : 'enabled'}
                  onChange={(e) => set('enabled', e.target.value === 'enabled')}
                >
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </select>
              </Field>
            </div>
            <Field label="Environment">
                <select value={env?.id ?? draft.environmentId ?? ''} onChange={(e) => setEnvironment(e.target.value)}>
                  {!env && <option value={draft.environmentId ?? ''}>Unknown environment ({draft.environmentId || 'none'})</option>}
                  {environments.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Working directory">
                <div className="browse-row">
                  <input
                    className="mono"
                    value={draft.cwd}
                    onChange={(e) => set('cwd', e.target.value)}
                  />
                  <button className="btn" onClick={() => void browseCwd()}>
                    Browse…
                  </button>
                </div>
            </Field>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'trigger' ? ' hidden' : ''}`}>
          <div className="form">
            <Field label="Frequency">
              <select
                value={schedForm.mode === 'minutes' || schedForm.mode === 'hours' ? 'every' : schedForm.mode}
                onChange={(e) => setScheduleMode(e.target.value as 'every' | CronForm['mode'])}
              >
                <option value="every">Every…</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="custom">Custom</option>
              </select>
            </Field>
              {(schedForm.mode === 'minutes' || schedForm.mode === 'hours') && (
                <Field label="Every">
                  <div className="browse-row">
                    <div className="input-suffix">
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={everyH}
                        onChange={(e) => {
                          const h = Number(e.target.value);
                          if (!Number.isInteger(h) || h < 0 || h > 23) return;
                          if (h === 0) {
                            setSchedule({ mode: 'minutes', step: Math.max(1, everyM), from: schedForm.from, to: schedForm.to, days: schedForm.days });
                          } else {
                            setSchedule({ mode: 'hours', step: h, minute: everyM, from: schedForm.from, to: schedForm.to, days: schedForm.days });
                          }
                        }}
                      />
                      <span className="suffix">h</span>
                    </div>
                    <div className="input-suffix">
                      <input
                        type="number"
                        min={everyH > 0 ? 0 : 1}
                        max={59}
                        value={everyM}
                        onChange={(e) => {
                          const m = Number(e.target.value);
                          if (!Number.isInteger(m) || m < 0 || m > 59) return;
                          if (everyH === 0) {
                            if (m >= 1) setSchedule({ mode: 'minutes', step: m, from: schedForm.from, to: schedForm.to, days: schedForm.days });
                          } else {
                            setSchedule({ mode: 'hours', step: everyH, minute: m, from: schedForm.from, to: schedForm.to, days: schedForm.days });
                          }
                        }}
                      />
                      <span className="suffix">min</span>
                    </div>
                  </div>
                </Field>
              )}
              {schedForm.mode === 'monthly' && (
                <Field label="Days of month">
                  <div className="dom-row">
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => {
                      const on = schedForm.days.includes(d);
                      return (
                        <button
                          key={d}
                          className={`btn small day-toggle ${on ? 'selected' : ''}`}
                          onClick={() => {
                            const days = on ? schedForm.days.filter((x) => x !== d) : [...schedForm.days, d];
                            if (days.length > 0) setSchedule({ ...schedForm, days });
                          }}
                        >
                          {d}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              )}
              {(schedForm.mode === 'weekly' || schedForm.mode === 'monthly') && (
                <Field label="At">
                  <input
                    type="time"
                    value={`${String(schedForm.hour).padStart(2, '0')}:${String(schedForm.minute).padStart(2, '0')}`}
                    onChange={(e) => {
                      const m = /^(\d{2}):(\d{2})$/.exec(e.target.value);
                      if (m) setSchedule({ ...schedForm, hour: Number(m[1]), minute: Number(m[2]) });
                    }}
                  />
                </Field>
              )}
              <Field label="Check timeout">
                <div className="input-suffix">
                  <input type="number" min={1} value={draft.check.timeoutSec ?? 60} onChange={(e) => setCheck('timeoutSec', Number(e.target.value))} />
                  <span className="suffix">s</span>
                </div>
              </Field>
            {(schedForm.mode === 'minutes' || schedForm.mode === 'hours') && (
              <>
                <Field label="Active hours">
                  <div className="browse-row">
                    <select
                      value={schedForm.from !== undefined ? 'window' : 'all'}
                      onChange={(e) =>
                        setSchedule(
                          e.target.value === 'window'
                            ? { ...schedForm, from: 9, to: 18 }
                            : { ...schedForm, from: undefined, to: undefined },
                        )
                      }
                    >
                      <option value="all">All day</option>
                      <option value="window">Between…</option>
                    </select>
                    {schedForm.from !== undefined && schedForm.to !== undefined && (
                      <>
                        <input
                          type="number"
                          min={0}
                          max={23}
                          value={schedForm.from}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isInteger(v) && v >= 0 && v <= 23)
                              setSchedule({ ...schedForm, from: v, to: Math.max(v, schedForm.to!) });
                          }}
                        />
                        <span className="muted">to</span>
                        <input
                          type="number"
                          min={0}
                          max={23}
                          value={schedForm.to}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isInteger(v) && v >= 0 && v <= 23)
                              setSchedule({ ...schedForm, to: v, from: Math.min(v, schedForm.from!) });
                          }}
                        />
                        <span className="muted">h</span>
                      </>
                    )}
                  </div>
                </Field>
                <Field label="On days">
                  <div className="day-row">
                    {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                      <button
                        key={d}
                        className={`btn small day-toggle ${constraintDays.includes(d) ? 'selected' : ''}`}
                        onClick={() => toggleConstraintDay(d)}
                      >
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]}
                      </button>
                    ))}
                  </div>
                </Field>
              </>
            )}
            {schedForm.mode === 'daily' && (
              <Field label="At">
                <div className="time-chip-row">
                  {schedForm.times.map((t, i) => (
                    <span key={i} className="time-chip">
                      <input
                        type="time"
                        value={`${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`}
                        onChange={(e) => {
                          const m = /^(\d{2}):(\d{2})$/.exec(e.target.value);
                          if (!m) return;
                          const times = schedForm.times.map((x, j) =>
                            j === i ? { hour: Number(m[1]), minute: Number(m[2]) } : x,
                          );
                          setDailyTimes(times);
                        }}
                      />
                      {schedForm.times.length > 1 && (
                        <button
                          className="btn small"
                          title="Remove this time"
                          onClick={() => setDailyTimes(schedForm.times.filter((_, j) => j !== i))}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  <button className="btn small" onClick={addDailyTime}>
                    Add time
                  </button>
                </div>
                {timesWarn && (
                  <p className="help warn">Times must share the hour or the minute to fit one cron expression.</p>
                )}
              </Field>
            )}
            {schedForm.mode === 'weekly' && (
              <Field label="On days">
                <div className="day-row">
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                    const on = schedForm.days.includes(d);
                    return (
                      <button
                        key={d}
                        className={`btn small day-toggle ${on ? 'selected' : ''}`}
                        onClick={() => {
                          const days = on ? schedForm.days.filter((x) => x !== d) : [...schedForm.days, d];
                          if (days.length > 0) setSchedule({ ...schedForm, days });
                        }}
                      >
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}
            {schedForm.mode === 'custom' && (
              <Field label="Cron expression">
                <input className="mono" value={cronExpr} onChange={(e) => set('schedule', { cron: e.target.value })} />
              </Field>
            )}
            {!cronNext && <p className="help"><span className="warn">Invalid cron expression.</span></p>}
            <Field label="Check command">
              <input className="mono" value={draft.check.command} onChange={(e) => setCheck('command', e.target.value)} />
            </Field>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'conditions' ? ' hidden' : ''}`}>
          <div className="form">
            <Field label="Classifier step">
              <select
                value={draft.classifier ? 'on' : 'off'}
                onChange={(e) => set('classifier', e.target.value === 'on' ? { ...EXAMPLE_TASK.classifier! } : undefined)}
              >
                <option value="off">Off</option>
                <option value="on">On</option>
              </select>
            </Field>
            {draft.classifier && (() => {
              const clsHarness = harnesses.find((h) => h.id === draft.classifier!.harnessId) ?? harnesses[0];
              const clsModels = clsHarness ? harnessModels(clsHarness) : [];
              const clsModelIsCustom = customClsModel || (!!draft.classifier!.model && !clsModels.some((m) => m.id === draft.classifier!.model));
              return (
              <>
                <div className="row">
                  <Field label="Harness">
                    <select
                      value={clsHarness?.id ?? ''}
                      disabled={!harnesses.length}
                      onChange={(e) => set('classifier', { ...draft.classifier!, harnessId: e.target.value })}
                    >
                      {!harnesses.length && <option value="">No harnesses in this environment</option>}
                      {harnesses.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name} ({harnessKindLabel(h.kind)})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Model">
                    <select
                      value={clsModelIsCustom ? 'custom' : draft.classifier!.model ?? ''}
                      onChange={(e) => {
                        if (e.target.value === 'custom') {
                          setCustomClsModel(true);
                        } else {
                          setCustomClsModel(false);
                          set('classifier', { ...draft.classifier!, model: e.target.value || clsModels[0]?.id || 'haiku' });
                        }
                      }}
                    >
                      {clsModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                      <option value="custom">Custom…</option>
                    </select>
                  </Field>
                  {clsModelIsCustom && (
                    <Field label="Model id">
                      <input
                        className="mono"
                        value={draft.classifier!.model ?? ''}
                        placeholder="model id"
                        onChange={(e) => set('classifier', { ...draft.classifier!, model: e.target.value || undefined })}
                      />
                    </Field>
                  )}
                </div>
                <div className="row">
                  <Field label="Timeout">
                    <div className="input-suffix">
                      <input
                        type="number"
                        min={1}
                        value={draft.classifier.timeoutSec ?? 180}
                        onChange={(e) => set('classifier', { ...draft.classifier!, timeoutSec: Number(e.target.value) })}
                      />
                      <span className="suffix">s</span>
                    </div>
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
                  <textarea rows={5} value={draft.classifier.prompt} onChange={(e) => set('classifier', { ...draft.classifier!, prompt: e.target.value })} />
                </Field>
              </>
              );
            })()}
          </div>
        </div>

        <div className={`editor-panel${tab !== 'action' ? ' hidden' : ''}`}>
          <div className="form">
            <div className="row">
              <Field label="Harness">
                <select
                  value={harness?.id ?? ''}
                  disabled={!harnesses.length}
                  onChange={(e) => setAgent('harnessId', e.target.value)}
                >
                  {!harnesses.length && <option value="">No harnesses in this environment</option>}
                  {harnesses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} ({harnessKindLabel(h.kind)})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Session type">
                <select value={draft.agent.mode ?? 'interactive'} onChange={(e) => setAgent('mode', e.target.value as 'interactive' | 'headless')}>
                  <option value="interactive">Interactive terminal (default)</option>
                  <option value="headless">Headless{harness?.kind === 'codex' ? ' (codex exec)' : ''}</option>
                </select>
              </Field>
            </div>
            {(isClaude || harness?.kind === 'codex') && (
              <div className="row">
                <Field label="Model">
                  <select
                    value={modelIsCustom ? 'custom' : draft.agent.model ?? ''}
                    onChange={(e) => {
                      if (e.target.value === 'custom') {
                        setCustomModel(true);
                      } else {
                        setCustomModel(false);
                        setAgent('model', e.target.value || undefined);
                      }
                    }}
                  >
                    <option value="">Default</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                    <option value="custom">Custom…</option>
                  </select>
                </Field>
                {modelIsCustom && (
                  <Field label="Model id">
                    <input
                      className="mono"
                      value={draft.agent.model ?? ''}
                      placeholder="model id"
                      onChange={(e) => setAgent('model', e.target.value || undefined)}
                    />
                  </Field>
                )}
              </div>
            )}
            {isClaude && (
              <Field label="Permission mode">
                <select value={draft.agent.permissionMode ?? 'auto'} onChange={(e) => setAgent('permissionMode', e.target.value)}>
                  {PERMISSION_MODES.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field
              label="Agent prompt"
              help={
                <>
                  <code>{'{{summary}}'}</code> and <code>{'{{context}}'}</code> insert the check output (appended automatically if
                  you don't use them).
                </>
              }
            >
              <textarea rows={9} value={draft.agent.prompt} onChange={(e) => setAgent('prompt', e.target.value)} />
            </Field>
            <Field label="Extra command-line arguments">
              <input className="mono" value={extraArgsText} onChange={(e) => setExtraArgsText(e.target.value)} />
            </Field>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'settings' ? ' hidden' : ''}`}>
          <div className="form">
            <div className="row">
              <Field label="Max runtime">
                <div className="input-suffix">
                  <input type="number" min={1} value={draft.agent.maxRuntimeMin ?? 120} onChange={(e) => setAgent('maxRuntimeMin', Number(e.target.value))} />
                  <span className="suffix">min</span>
                </div>
              </Field>
              <Field label="Auto-pause after">
                <div className="input-suffix">
                  <input
                    type="number"
                    min={1}
                    value={draft.backoff?.maxConsecutiveErrors ?? 5}
                    onChange={(e) => set('backoff', { maxConsecutiveErrors: Number(e.target.value) })}
                  />
                  <span className="suffix">errors</span>
                </div>
              </Field>
            </div>
            <div className="row">
              <Field label="Idle grace">
                <div className="input-suffix">
                  <input type="number" min={1} value={draft.agent.idleGraceMin ?? 3} onChange={(e) => setAgent('idleGraceMin', Number(e.target.value))} />
                  <span className="suffix">min</span>
                </div>
              </Field>
              <Field label="When idle too long">
                <select value={draft.agent.onIdleTimeout ?? 'finish'} onChange={(e) => setAgent('onIdleTimeout', e.target.value as 'finish' | 'hold')}>
                  <option value="finish">End the run</option>
                  <option value="hold">Hold and wait for me</option>
                </select>
              </Field>
            </div>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'json' ? ' hidden' : ''}`}>
          <textarea className="json-editor mono" value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
        </div>
      </div>
      <div className="editor-footer">
        <button className="btn primary" onClick={() => void save()} disabled={saving}>
          Save
        </button>
        <button className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button className="btn" onClick={() => void apply()} disabled={saving}>
          Apply
        </button>
      </div>
    </div>
  );
}
