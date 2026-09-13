import { useState } from 'react';
import { Cron } from 'croner';
import type { Environment, Task, TaskInput } from '@shared/types';
import { ALL_DAYS, TIMEZONE_ALIASES, cronToForm, cronTz, formToCron, timesExpressible, type CronForm } from '@shared/cron';
import { slugify, validateTask } from '@shared/validate';
import { PERMISSION_MODES, harnessKindLabel, harnessModels, pathFlavor } from '@shared/environments';
import { envToLine, joinTokens, lineToEnv, tokenize } from '@shared/cmdline';
import { EXAMPLE_TASK } from '@shared/example-task';
import { Field, NumberField, NumberInput, TabBar, EditorFooter } from './ui';
import { useDialogKeys } from './hooks';

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
};

type NotifEndLevel = Exclude<NonNullable<NonNullable<TaskInput['notifications']>['end']>, 'off'>;

type EditorTab = 'general' | 'schedule' | 'check' | 'classifier' | 'agent' | 'settings' | 'notifications' | 'json';

const TABS: [EditorTab, string][] = [
  ['general', 'General'],
  ['schedule', 'Schedule'],
  ['check', 'Check'],
  ['classifier', 'Classifier'],
  ['agent', 'Agent'],
  ['settings', 'Settings'],
  ['notifications', 'Notifications'],
  ['json', 'Advanced'],
];

function blankDraft(environmentId?: string): Draft {
  return {
    ...EXAMPLE_TASK,
    id: '',
    name: '',
    cwd: '',
    environmentId: environmentId ?? '',
    check: { enabled: true, command: '', timeoutSec: 60 },
    classifier: undefined,
    agent: { ...EXAMPLE_TASK.agent, prompt: '' },
  } as Draft;
}

function toDraft(t: Task): Draft {
  return JSON.parse(JSON.stringify(t)) as Draft;
}

const TIMEZONES = [...Intl.supportedValuesOf('timeZone'), ...Object.keys(TIMEZONE_ALIASES)].sort();

/** Timezones grouped by region prefix; labels drop the region and read as words. */
const TIMEZONE_GROUPS = (() => {
  const groups = new Map<string, { id: string; label: string }[]>();
  for (const tz of TIMEZONES) {
    const slash = tz.indexOf('/');
    const region = slash === -1 ? 'Other' : tz.slice(0, slash);
    const label = (slash === -1 ? tz : tz.slice(slash + 1)).replaceAll('_', ' ').replaceAll('/', ' / ');
    let list = groups.get(region);
    if (!list) groups.set(region, (list = []));
    list.push({ id: tz, label });
  }
  return [...groups.entries()];
})();

/** ISO instant -> the `datetime-local` input's local "YYYY-MM-DDTHH:mm". */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The input's local value -> an ISO instant; empty (or unparseable) = nothing to store. */
function fromLocalInput(value: string): string | undefined {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** What a schedule end date starts at when the task has never had one: a week out. */
function defaultStopOn(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}


export function TaskEditor({ task, initial, environments, defaultEnvironmentId, host, mode = 'task', onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<Draft>(() =>
    task ? toDraft(task) : initial ? (JSON.parse(JSON.stringify(initial)) as Draft) : blankDraft(defaultEnvironmentId),
  );
  const [tab, setTab] = useState<EditorTab>('general');
  const [jsonText, setJsonText] = useState('');
  const [saving, setSaving] = useState(false);
  const [extraArgsText, setExtraArgsText] = useState(() => joinTokens((task ?? initial)?.agent?.extraArgs ?? []));
  const [envText, setEnvText] = useState(() => envToLine((task ?? initial)?.env ?? {}));
  // Pins the Model dropdown on "Custom" even while the typed value matches a preset.
  const [customModel, setCustomModel] = useState(false);
  const [customClsModel, setCustomClsModel] = useState(false);
  // Remembers the end-notification level while "Notify when the task ends" is off.
  const [rememberedEnd, setRememberedEnd] = useState<NotifEndLevel>(() => {
    const e = (task ?? initial)?.notifications?.end;
    return e && e !== 'off' ? e : 'warning';
  });

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
    set('schedule', { ...draft.schedule, cron: formToCron(f) });
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
    cronNext = new Cron(cronExpr, cronTz(draft.schedule.timezone)).nextRun()?.toLocaleString() ?? undefined;
  } catch {
    /* invalid expression or timezone: preview shows an error instead */
  }
  const env = environments.find((e) => e.id === draft.environmentId);
  const harnesses = env?.harnesses ?? [];
  const harness = harnesses.find((h) => h.id === draft.agent.harnessId) ?? harnesses[0];
  const harnessKind = harness?.kind ?? 'claude-code';
  const isClaude = harnessKind === 'claude-code';
  const isCodex = harnessKind === 'codex';
  const permissionModes = harnessKind === 'custom' ? [] : PERMISSION_MODES[harnessKind];
  const models = harness ? harnessModels(harness) : [];
  // Model presets come from the harness; anything else is edited as "Custom".
  const modelIsCustom = customModel || (!!draft.agent.model && !models.some((m) => m.id === draft.agent.model));
  const schedOn = draft.schedule.enabled !== false;
  // The end date keeps its value while switched off, like every other step here.
  const stopOn = draft.schedule.stopOn;
  const stopOnEnabled = stopOn?.enabled ?? false;
  const setStopOn = (next: NonNullable<Draft['schedule']['stopOn']>) => set('schedule', { ...draft.schedule, stopOn: next });
  const checkOn = !!draft.check && draft.check.enabled !== false;
  const clsOn = !!draft.classifier && draft.classifier.enabled !== false;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setAgent = <K extends keyof Draft['agent']>(key: K, value: Draft['agent'][K]) =>
    setDraft((d) => ({ ...d, agent: { ...d.agent, [key]: value } }));
  /** Switching to another harness kind: its model ids and permission modes don't carry over. */
  const setHarness = (id: string) => {
    const next = harnesses.find((h) => h.id === id);
    const kind = next?.kind ?? 'claude-code';
    setDraft((d) => {
      const agent = { ...d.agent, harnessId: id };
      if (kind !== harnessKind) {
        agent.model = undefined;
        if (kind !== 'custom' && !PERMISSION_MODES[kind].some(([v]) => v === (agent.permissionMode ?? 'auto'))) {
          agent.permissionMode = 'auto';
        }
      }
      return { ...d, agent };
    });
    if (kind !== harnessKind) setCustomModel(false);
  };
  const notif = draft.notifications ?? {};
  const setNotif = <K extends keyof NonNullable<Draft['notifications']>>(key: K, value: NonNullable<Draft['notifications']>[K]) =>
    setDraft((d) => ({ ...d, notifications: { ...(d.notifications ?? {}), [key]: value } }));
  // The draft's end level is the source of truth while on; the remembered one shows while off.
  const endLevel: NotifEndLevel = notif.end && notif.end !== 'off' ? notif.end : rememberedEnd;
  const endOn = (notif.end ?? 'warning') !== 'off';
  const completion = draft.completion ?? {};
  const setCompletion = <K extends keyof NonNullable<Draft['completion']>>(key: K, value: NonNullable<Draft['completion']>[K]) =>
    setDraft((d) => ({ ...d, completion: { ...(d.completion ?? {}), [key]: value } }));
  // Status is three states over two fields: a completed task is never enabled.
  const status = draft.completedAt ? 'completed' : draft.enabled === false ? 'disabled' : 'enabled';
  const setStatus = (next: 'enabled' | 'disabled' | 'completed') =>
    setDraft((d) => ({
      ...d,
      enabled: next === 'enabled',
      completedAt: next === 'completed' ? (d.completedAt ?? new Date().toISOString()) : undefined,
      completedReason: next === 'completed' ? (d.completedReason ?? 'completed by the user') : undefined,
    }));
  const setCheck = <K extends keyof NonNullable<Draft['check']>>(key: K, value: NonNullable<Draft['check']>[K]) =>
    setDraft((d) => ({ ...d, check: { ...d.check!, [key]: value } }));
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

  /** Throws when the extra-arguments or env line is malformed. */
  function assemble(): Record<string, unknown> {
    const parsedArgs = tokenize(extraArgsText);
    if (!parsedArgs.ok) throw new Error(`Extra command-line arguments: ${parsedArgs.error}`);
    const parsedEnv = lineToEnv(envText);
    if (typeof parsedEnv === 'string') throw new Error(`Extra environment variables: ${parsedEnv}`);
    return {
      ...draft,
      id: draft.id?.trim() || slugify(draft.name),
      env: parsedEnv,
      // A step turned off with nothing configured is dropped rather than saved empty.
      check: draft.check && (checkOn || (draft.check.command ?? '').trim()) ? draft.check : undefined,
      classifier: draft.classifier && (clsOn || (draft.classifier.prompt ?? '').trim()) ? draft.classifier : undefined,
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
    setEnvText(obj.env && typeof obj.env === 'object' ? envToLine(obj.env as Record<string, string>) : '');
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
    const v = validateTask(obj, environments, host, mode === 'template' ? { template: true } : undefined);
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

  useDialogKeys<EditorTab>({ onSave: save, onCancel, tabs: TABS.map(([id]) => id), tab, onTab: switchTab });

  return (
    <div className="editor">
      <TabBar tabs={TABS} active={tab} onSelect={switchTab} className="editor-tabs" />
      <div className="editor-body">
        <div className={`editor-panel${tab !== 'general' ? ' hidden' : ''}`}>
          <div className="form">
            <Field label="Task name">
              <input autoFocus value={draft.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <div className="row">
              <Field label="Status">
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as 'enabled' | 'disabled' | 'completed')}
                >
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                  <option value="completed" disabled={!completion.allowed && !draft.completedAt}>
                    Completed
                  </option>
                </select>
              </Field>
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={completion.allowed ?? false}
                onChange={(e) => setCompletion('allowed', e.target.checked)}
              />
              Allow this task to be marked completed
            </label>
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

        <div className={`editor-panel${tab !== 'schedule' ? ' hidden' : ''}`}>
          <div className="form">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={schedOn}
                onChange={(e) => set('schedule', { ...draft.schedule, enabled: e.target.checked })}
              />
              Run automatically on a schedule
            </label>
            <fieldset className={`step-fields${schedOn ? '' : ' disabled'}`} disabled={!schedOn}>
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
                    <NumberInput
                      min={0}
                      max={23}
                      suffix="h"
                      value={everyH}
                      onChange={(h) => {
                        if (!Number.isInteger(h) || h < 0 || h > 23) return;
                        if (h === 0) {
                          setSchedule({ mode: 'minutes', step: Math.max(1, everyM), from: schedForm.from, to: schedForm.to, days: schedForm.days });
                        } else {
                          setSchedule({ mode: 'hours', step: h, minute: everyM, from: schedForm.from, to: schedForm.to, days: schedForm.days });
                        }
                      }}
                    />
                    <NumberInput
                      min={everyH > 0 ? 0 : 1}
                      max={59}
                      suffix="min"
                      value={everyM}
                      onChange={(m) => {
                        if (!Number.isInteger(m) || m < 0 || m > 59) return;
                        if (everyH === 0) {
                          if (m >= 1) setSchedule({ mode: 'minutes', step: m, from: schedForm.from, to: schedForm.to, days: schedForm.days });
                        } else {
                          setSchedule({ mode: 'hours', step: everyH, minute: m, from: schedForm.from, to: schedForm.to, days: schedForm.days });
                        }
                      }}
                    />
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
            {(schedForm.mode === 'minutes' || schedForm.mode === 'hours') && (
              <>
                <Field label="Active hours">
                  <div className="browse-row hours-row">
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
                        <NumberInput
                          min={0}
                          max={23}
                          suffix="h"
                          value={schedForm.from}
                          onChange={(v) => {
                            if (Number.isInteger(v) && v >= 0 && v <= 23)
                              setSchedule({ ...schedForm, from: v, to: Math.max(v, schedForm.to!) });
                          }}
                        />
                        <span className="muted">to</span>
                        <NumberInput
                          min={0}
                          max={23}
                          suffix="h"
                          value={schedForm.to}
                          onChange={(v) => {
                            if (Number.isInteger(v) && v >= 0 && v <= 23)
                              setSchedule({ ...schedForm, to: v, from: Math.min(v, schedForm.from!) });
                          }}
                        />
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
                <input className="mono" value={cronExpr} onChange={(e) => set('schedule', { ...draft.schedule, cron: e.target.value })} />
              </Field>
            )}
            {!cronNext && <p className="help"><span className="warn">Invalid cron expression.</span></p>}
            <Field label="Timezone">
              <select
                value={draft.schedule.timezone ?? ''}
                onChange={(e) =>
                  set('schedule', { ...draft.schedule, timezone: e.target.value || undefined })
                }
              >
                <option value="">Use computer timezone</option>
                {draft.schedule.timezone && !TIMEZONES.includes(draft.schedule.timezone) && (
                  <option value={draft.schedule.timezone}>{draft.schedule.timezone}</option>
                )}
                {TIMEZONE_GROUPS.map(([region, zones]) => (
                  <optgroup key={region} label={region}>
                    {zones.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={stopOnEnabled}
                onChange={(e) => setStopOn({ enabled: e.target.checked, at: stopOn?.at ?? defaultStopOn() })}
              />
              End the schedule on a date
            </label>
            <div className={`step-fields${stopOnEnabled ? '' : ' disabled'}`}>
              <Field label="Stop running on">
                <input
                  type="datetime-local"
                  disabled={!stopOnEnabled}
                  value={toLocalInput(stopOn?.at)}
                  onChange={(e) => setStopOn({ enabled: true, at: fromLocalInput(e.target.value) ?? stopOn!.at })}
                />
              </Field>
            </div>
            </fieldset>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'check' ? ' hidden' : ''}`}>
          <div className="form">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={checkOn}
                onChange={(e) =>
                  set('check', { ...(draft.check ?? { command: '', timeoutSec: 60 }), enabled: e.target.checked })
                }
              />
              Run a command to check whether the agent should run
            </label>
            <div className={`step-fields${checkOn ? '' : ' disabled'}`}>
              <Field label="Command">
                <input
                  className="mono"
                  disabled={!checkOn}
                  value={draft.check?.command ?? ''}
                  onChange={(e) => setCheck('command', e.target.value)}
                />
              </Field>
              <NumberField
                label="Timeout"
                suffix="s"
                min={1}
                disabled={!checkOn}
                value={draft.check?.timeoutSec ?? 60}
                onChange={(n) => setCheck('timeoutSec', n)}
              />
            </div>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'classifier' ? ' hidden' : ''}`}>
          <div className="form">
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={clsOn}
                onChange={(e) =>
                  set('classifier', { ...(draft.classifier ?? EXAMPLE_TASK.classifier!), enabled: e.target.checked })
                }
              />
              Ask a model whether the agent should run
            </label>
            {(() => {
              const cls = draft.classifier;
              const clsHarness = harnesses.find((h) => h.id === cls?.harnessId) ?? harnesses[0];
              const clsModels = clsHarness ? harnessModels(clsHarness) : [];
              const clsModelIsCustom = customClsModel || (!!cls?.model && !clsModels.some((m) => m.id === cls.model));
              return (
              <div className={`step-fields${clsOn ? '' : ' disabled'}`}>
                <div className="row">
                  <Field label="Harness">
                    <select
                      value={clsHarness?.id ?? ''}
                      disabled={!clsOn || !harnesses.length}
                      onChange={(e) => {
                        // Model ids don't carry across harnesses: snap to the new harness's first preset.
                        const h = harnesses.find((x) => x.id === e.target.value);
                        const presets = h ? harnessModels(h) : [];
                        const cur = draft.classifier?.model;
                        const model = cur && presets.some((m) => m.id === cur) ? cur : (presets[0]?.id ?? cur ?? 'haiku');
                        setCustomClsModel(false);
                        set('classifier', { ...draft.classifier!, harnessId: e.target.value, model });
                      }}
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
                    <select
                      value={cls?.mode ?? 'headless'}
                      disabled={!clsOn}
                      onChange={(e) => set('classifier', { ...draft.classifier!, mode: e.target.value as 'interactive' | 'headless' })}
                    >
                      <option value="headless">Headless (default)</option>
                      <option value="interactive">Interactive terminal</option>
                    </select>
                  </Field>
                </div>
                <div className="row">
                  <Field label="Model">
                    <select
                      value={clsModelIsCustom ? 'custom' : cls?.model ?? 'haiku'}
                      disabled={!clsOn}
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
                        disabled={!clsOn}
                        value={cls?.model ?? ''}
                        placeholder="model id"
                        onChange={(e) => set('classifier', { ...draft.classifier!, model: e.target.value || undefined })}
                      />
                    </Field>
                  )}
                </div>
                <div className="row">
                  <NumberField
                    label="Timeout"
                    suffix="s"
                    min={1}
                    disabled={!clsOn}
                    value={cls?.timeoutSec ?? 180}
                    onChange={(n) => set('classifier', { ...draft.classifier!, timeoutSec: n })}
                  />
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
                  <textarea rows={5} disabled={!clsOn} value={cls?.prompt ?? ''} onChange={(e) => set('classifier', { ...draft.classifier!, prompt: e.target.value })} />
                </Field>
              </div>
              );
            })()}
          </div>
        </div>

        <div className={`editor-panel${tab !== 'agent' ? ' hidden' : ''}`}>
          <div className="form">
            <div className="row">
              <Field label="Harness">
                <select
                  value={harness?.id ?? ''}
                  disabled={!harnesses.length}
                  onChange={(e) => setHarness(e.target.value)}
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
                  <option value="headless">Headless{isCodex ? ' (codex exec)' : ''}</option>
                </select>
              </Field>
            </div>
            {(isClaude || isCodex) && (
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
                {permissionModes.length > 0 && (
                  <Field label="Permission mode">
                    <select value={draft.agent.permissionMode ?? 'auto'} onChange={(e) => setAgent('permissionMode', e.target.value)}>
                      {permissionModes.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            )}
            {(isClaude || isCodex) && (
              <div className="row">
                <Field label="Conversation">
                  <select
                    value={draft.agent.session ?? 'fresh'}
                    onChange={(e) => setAgent('session', e.target.value as 'fresh' | 'continue')}
                  >
                    <option value="fresh">Start new on each run</option>
                    <option value="continue">Continue previous across runs</option>
                  </select>
                </Field>
                {(draft.agent.session ?? 'fresh') === 'continue' && (
                  <NumberField
                    label="Start a new conversation after"
                    suffix="runs"
                    min={1}
                    value={draft.agent.sessionMaxRuns ?? 10}
                    onChange={(n) => setAgent('sessionMaxRuns', n)}
                  />
                )}
              </div>
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
            <div className="row">
              <Field label="Extra command-line arguments">
                <input className="mono" value={extraArgsText} onChange={(e) => setExtraArgsText(e.target.value)} />
              </Field>
              <Field label="Extra environment variables">
                <input className="mono" value={envText} onChange={(e) => setEnvText(e.target.value)} />
              </Field>
            </div>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'settings' ? ' hidden' : ''}`}>
          <div className="form">
            <div className="row">
              <NumberField
                label="Max runtime"
                suffix="min"
                min={1}
                value={draft.agent.maxRuntimeMin ?? 120}
                onChange={(n) => setAgent('maxRuntimeMin', n)}
              />
              <NumberField
                label="Auto-pause after"
                suffix="errors"
                min={1}
                value={draft.backoff?.maxConsecutiveErrors ?? 5}
                onChange={(n) => set('backoff', { maxConsecutiveErrors: n })}
              />
            </div>
            <div className="row">
              <NumberField
                label="Idle grace"
                suffix="min"
                min={1}
                value={draft.agent.idleGraceMin ?? 3}
                onChange={(n) => setAgent('idleGraceMin', n)}
              />
              <Field label="When idle too long">
                <select value={draft.agent.onIdleTimeout ?? 'finish'} onChange={(e) => setAgent('onIdleTimeout', e.target.value as 'finish' | 'hold')}>
                  <option value="finish">End the run</option>
                  <option value="hold">Hold and wait for me</option>
                </select>
              </Field>
            </div>
            <div className="row">
              <NumberField
                label="Simultaneous runs"
                suffix="runs"
                min={1}
                value={draft.maxConcurrentRuns ?? 1}
                onChange={(n) => set('maxConcurrentRuns', n)}
              />
            </div>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'notifications' ? ' hidden' : ''}`}>
          <div className="form">
            <label className="checkbox-field">
              <input type="checkbox" checked={notif.runStart ?? false} onChange={(e) => setNotif('runStart', e.target.checked)} />
              Notify when a run starts
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={notif.agentStart ?? false} onChange={(e) => setNotif('agentStart', e.target.checked)} />
              Notify when the agent starts
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={endOn}
                onChange={(e) => {
                  if (!e.target.checked) setRememberedEnd(endLevel);
                  setNotif('end', e.target.checked ? endLevel : 'off');
                }}
              />
              Notify when the task ends
            </label>
            <fieldset className={`step-fields radio-list${endOn ? '' : ' disabled'}`} disabled={!endOn}>
              {(
                [
                  ['error', 'With an error'],
                  ['warning', 'With an error or warning'],
                  ['end', 'With any result except no action'],
                  ['all', 'With any result'],
                ] as [NotifEndLevel, string][]
              ).map(([value, label]) => (
                <label key={value} className="checkbox-field">
                  <input
                    type="radio"
                    name="notif-end"
                    checked={endLevel === value}
                    onChange={() => {
                      setRememberedEnd(value);
                      setNotif('end', value);
                    }}
                  />
                  {label}
                </label>
              ))}
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={notif.networkErrors ?? false}
                  onChange={(e) => setNotif('networkErrors', e.target.checked)}
                />
                Include network errors
              </label>
            </fieldset>
            <label className="checkbox-field">
              <input type="checkbox" checked={notif.held ?? false} onChange={(e) => setNotif('held', e.target.checked)} />
              Notify when the agent holds and waits for input
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={notif.autoPaused ?? false} onChange={(e) => setNotif('autoPaused', e.target.checked)} />
              Notify when the task auto-pauses
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={notif.completed ?? false} onChange={(e) => setNotif('completed', e.target.checked)} />
              Notify when the task completes
            </label>
            <label className="checkbox-field">
              <input type="checkbox" checked={notif.usageLimit ?? false} onChange={(e) => setNotif('usageLimit', e.target.checked)} />
              Notify when the usage limit is reached
            </label>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'json' ? ' hidden' : ''}`}>
          <textarea className="json-editor mono" value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
        </div>
      </div>
      <EditorFooter onPrimary={() => void save()} onCancel={onCancel} onApply={() => void apply()} saving={saving} />
    </div>
  );
}
