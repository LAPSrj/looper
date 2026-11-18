import { useState } from 'react';
import { Cron } from 'croner';
import { RELATED_ID_FIELD, type Environment, type Project, type Task, type TaskInput } from '@shared/types';
import { ALL_DAYS, TIMEZONE_ALIASES, cronToForm, formToCron, timesExpressible, type CronForm } from '@shared/cron';
import { slugify, validateTask } from '@shared/validate';
import { EFFORT_LEVELS, PERMISSION_MODES, harnessModels, pathFlavor } from '@shared/environments';
import { agentDiffers, projectAgentIn, sameFolder, withProjectAgent } from '@shared/projects';
import { envToLine, joinTokens } from '@shared/cmdline';
import { claudeArgsProblem } from '@shared/claude-args';
import { EXAMPLE_TASK } from '@shared/example-task';
import { CheckboxField, Field, FieldRow, FormGroup, InlineField, InputRow, NumberField, NumberInput, RadioField, RangeField, SelectInput, StepFields, TabBar, TextArea, TextInput, ToggleButtons } from './ui';
import { WindowActions } from './WindowActions';
import { useDialogKeys, useSave } from './hooks';
import { parseArgsEnv } from './form-blocks';import { blankDraft, type Draft } from './blank-draft';
import { AgentFields, type AgentDraft } from './RemoteFields';

interface Props {
  task: Task | null;
  /** Prefill for a NEW task (e.g. the example task); ignored when editing. */
  initial?: TaskInput;
  /** The configured environments (Tools → Settings → Environments). */
  environments: Environment[];
  projects: Project[];
  /** A new task's project (a project's New Task…). */
  projectId?: string;
  /** Environment preselected for new tasks (from global settings). */
  defaultEnvironmentId?: string;
  /** Host kind, deciding the path style of `local` environments. */
  host?: string;
  /** 'template' saves to the template store instead of the task store. */
  mode?: 'task' | 'template';
  /** The definition came from a task builder: saving records the agent's version. */
  builderId?: string;
  onSaved: () => void;
  onCancel: () => void;
}

/** The context limit a task gets when the restart option is turned on. */
const DEFAULT_CONTEXT_LIMIT_K = 400;
const DEFAULT_MAX_WAIT_SEC = 60;

type NotifEndLevel =Exclude<NonNullable<NonNullable<TaskInput['notifications']>['end']>, 'off'>;
type EditorTab = 'general' | 'trigger' | 'check' | 'classifier' | 'agent' | 'settings' | 'notifications' | 'json';

const TABS: [EditorTab, string][] = [
  ['general', 'General'],
  ['trigger', 'Trigger'],
  ['check', 'Check'],
  ['classifier', 'Classifier'],
  ['agent', 'Agent'],
  ['settings', 'Settings'],
  ['notifications', 'Notifications'],
  ['json', 'Advanced'],
];

function toDraft(t: Task): Draft {
  return JSON.parse(JSON.stringify(t)) as Draft;
}

/**
 * The agent for another harness: a harness of another kind doesn't share
 * model ids, and a permission mode or effort it doesn't know goes back to the default.
 */
function fitAgent(agent: Draft['agent'], harnessId: string | undefined, env: Environment | undefined): Draft['agent'] {
  const kindOf = (id?: string) => (id ? env?.harnesses.find((h) => h.id === id) : env?.harnesses[0])?.kind ?? 'claude-code';
  const from = kindOf(agent.harnessId);
  const to = kindOf(harnessId);
  const next = { ...agent, harnessId };
  if (to === from) return next;
  next.model = undefined;
  if (to !== 'custom') {
    if (!PERMISSION_MODES[to].some(([v]) => v === (next.permissionMode ?? 'auto'))) next.permissionMode = 'auto';
    if (next.effort && !EFFORT_LEVELS[to].some(([v]) => v === next.effort)) next.effort = undefined;
  }
  return next;
}

/** The draft in its project: the project's folder, and its environment and agent settings unless the task overrides them. */
function withProject(d: Draft, p: Project, environments: Environment[]): Draft {
  const environmentId = d.overrideEnvironment ? (d.environmentId ?? p.environmentId) : p.environmentId;
  const agent = d.overrideAgent
    ? fitAgent(d.agent, d.agent.harnessId, environments.find((e) => e.id === environmentId))
    : (withProjectAgent(d.agent as Task['agent'], projectAgentIn(p, environmentId, environments)) as Draft['agent']);
  return { ...d, projectId: p.id, cwd: p.cwd, environmentId, agent };
}

/**
 * Where a draft that comes in (a task, an import, a template) belongs: its own
 * project, else the project of its folder (agent settings other than the
 * project's stay as an override), else a new project for its folder.
 */
function placeDraft(d: Draft, projects: Project[], environments: Environment[]): Draft {
  const own = projects.find((p) => p.id === d.projectId);
  if (own) return withProject(d, own, environments);
  const byFolder = d.cwd && d.environmentId ? projects.find((p) => p.environmentId === d.environmentId && sameFolder(p.cwd, d.cwd!)) : undefined;
  if (!byFolder) return { ...d, projectId: undefined, overrideEnvironment: false, overrideAgent: false };
  const env = environments.find((e) => e.id === byFolder.environmentId);
  const pa = projectAgentIn(byFolder, byFolder.environmentId, environments);
  const differs = agentDiffers({ mode: 'interactive', permissionMode: 'auto', ...d.agent } as Task['agent'], pa, env);
  return withProject({ ...d, overrideEnvironment: false, overrideAgent: differs }, byFolder, environments);
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

function TimezoneSelect({ value, onChange, id }: { value?: string; onChange: (tz?: string) => void; id?: string }) {
  return (
    <SelectInput id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">Use computer timezone</option>
      {value && !TIMEZONES.includes(value) && <option value={value}>{value}</option>}
      {TIMEZONE_GROUPS.map(([region, zones]) => (
        <optgroup key={region} label={region}>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.label}
            </option>
          ))}
        </optgroup>
      ))}
    </SelectInput>
  );
}
TimezoneSelect.labelable = true;

/** The week's day buttons, Monday first (cron numbers, Sunday = 0). */
const WEEKDAYS: [number, string][] = [1, 2, 3, 4, 5, 6, 0].map((d) => [d, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]]);
const MONTH_DAYS: [number, string][] = Array.from({ length: 31 }, (_, i) => [i + 1, String(i + 1)]);

type Hours = { from: number; to: number };

/**
 * When a schedule or a watcher may run: all day, or between two hours. Each
 * box commits only itself per keystroke (clamping the other bound mid-typing
 * would destroy it: typing "20" passes through 2); the pair is normalized on
 * blur, and a passing from > to is rejected at save either way.
 */
function ActiveHours({ value, onChange }: { value: Hours | undefined; onChange: (hours: Hours | undefined) => void }) {
  const hour = (v: number) => Number.isInteger(v) && v >= 0 && v <= 23;
  const mode = (
    <SelectInput value={value ? 'window' : 'all'} onChange={(e) => onChange(e.target.value === 'window' ? { from: 9, to: 18 } : undefined)}>
      <option value="all">All day</option>
      <option value="window">Between…</option>
    </SelectInput>
  );
  const box = (bound: 'from' | 'to', hours: Hours, label?: string) => (
    <NumberInput
      min={0}
      max={23}
      suffix="h"
      label={label}
      value={hours[bound]}
      onChange={(v) => hour(v) && onChange({ ...hours, [bound]: v })}
      onBlur={(v) => {
        if (v === null) return;
        const next = { ...hours, [bound]: v };
        if (next.from > next.to) onChange({ from: v, to: v });
      }}
    />
  );
  return <RangeField label="Active hours" mode={mode} on={!!value} box={(bound, label) => value && box(bound, value, label)} fromLabel="From hour" toLabel="To hour" />;
}

export function TaskEditor({ task, initial, environments, projects, projectId, defaultEnvironmentId, host, mode = 'task', builderId, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<Draft>(() => {
    const d = task ? toDraft(task) : initial ? (JSON.parse(JSON.stringify(initial)) as Draft) : blankDraft(defaultEnvironmentId);
    return placeDraft(!task && !initial && projectId ? { ...d, projectId } : d, projects, environments);
  });
  const [tab, setTab] = useState<EditorTab>('general');
  const [jsonText, setJsonText] = useState('');
  const saver = useSave();
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

  // Trigger UI: mode picks which of schedule/watcher is active; the other's
  // configuration is kept around unselected, like a disabled step's fields.
  const trig = draft.trigger ?? { mode: 'schedule' as const };
  const trigMode = trig.mode ?? 'schedule';
  // trig.schedule?.cron is the single source of truth for the schedule
  // builder; the structured controls are a parsed view of it. `customCron`
  // pins the raw input open even when the expression matches a friendly pattern.
  const [customCron, setCustomCron] = useState(false);
  // Daily times must share the hour or the minute; a rejected chip edit shows a hint.
  const [timesWarn, setTimesWarn] = useState(false);
  const cronExpr = trig.schedule?.cron ?? '';
  // The expression as of the last blur: errors show only for it, not mid-typing.
  const [blurredCron, setBlurredCron] = useState(cronExpr);
  const schedForm: CronForm = customCron ? { mode: 'custom', cron: cronExpr } : cronToForm(cronExpr);
  const setSchedule = (f: CronForm) => {
    setTimesWarn(false);
    set('trigger', { ...trig, schedule: { ...trig.schedule, cron: formToCron(f) } });
  };
  /** Switch the trigger mode, seeding a blank config the first time a mode is entered. */
  const setTriggerMode = (mode: 'manual' | 'schedule' | 'watcher') => {
    const next: NonNullable<Draft['trigger']> = { ...trig, mode };
    if (mode === 'schedule' && !trig.schedule) next.schedule = { cron: '*/10 * * * *' };
    if (mode === 'watcher' && !trig.watcher) next.watcher = { command: '', debounceSec: 5 };
    set('trigger', next);
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
  let cronError: string | undefined;
  try {
    new Cron(cronExpr);
  } catch (e) {
    cronError = (e as Error).message.replace(/^CronPattern:\s*/, '');
  }
  const env = environments.find((e) => e.id === draft.environmentId);
  const harnesses = env?.harnesses ?? [];
  const harness = harnesses.find((h) => h.id === draft.agent.harnessId) ?? harnesses[0];
  const harnessKind = harness?.kind ?? 'claude-code';
  const isClaude = harnessKind === 'claude-code';
  const isCodex = harnessKind === 'codex';
  const models = harness ? harnessModels(harness) : [];
  // The end date keeps its value while switched off, like every other step here.
  const stopOn = trig.stopOn;
  const stopOnEnabled = stopOn?.enabled ?? false;
  const setStopOn = (next: NonNullable<Draft['trigger']>['stopOn']) => set('trigger', { ...trig, stopOn: next });
  const checkOn = !!draft.check && draft.check.enabled !== false;
  const clsOn = !!draft.classifier && draft.classifier.enabled !== false;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setAgent = <K extends keyof Draft['agent']>(key: K, value: Draft['agent'][K]) =>
    setDraft((d) => ({ ...d, agent: { ...d.agent, [key]: value } }));
  /** Switching to another harness kind: its model ids and permission modes don't carry over. */
  const setHarness = (id: string) => {
    if ((harnesses.find((h) => h.id === id)?.kind ?? 'claude-code') !== harnessKind) setCustomModel(false);
    setDraft((d) => ({ ...d, agent: fitAgent(d.agent, id, env) }));
  };
  /** A preset (or Default, ''): an effort the new model doesn't offer falls back to its default. */
  const pickModel = (id: string) => {
    const entry = models.find((m) => m.id === id);
    setDraft((d) => ({
      ...d,
      agent: {
        ...d.agent,
        model: id || undefined,
        effort: d.agent.effort && entry?.efforts && !entry.efforts.includes(d.agent.effort) ? undefined : d.agent.effort,
      },
    }));
  };
  const project = projects.find((p) => p.id === draft.projectId);
  // The agent settings follow the project until the task overrides them (StepFields disables them till then).
  const continueOn = (draft.agent.session ?? 'fresh') === 'continue';
  const projectEnv = project ? environments.find((e) => e.id === project.environmentId) : undefined;
  // A project's folder is written for one kind of environment: an override can only pick one of that kind.
  const envChoices = projectEnv ? environments.filter((e) => e.id === draft.environmentId || pathFlavor(e, host) === pathFlavor(projectEnv, host)) : environments;
  /** '' = a new project for the folder typed below. */
  const pickProject = (id: string) => {
    setCustomModel(false);
    setDraft((d) => {
      const p = projects.find((x) => x.id === id);
      if (p) return withProject(d, p, environments);
      return { ...d, projectId: undefined, overrideEnvironment: false, overrideAgent: false, cwd: '' };
    });
  };
  const setOverride = (key: 'overrideEnvironment' | 'overrideAgent', on: boolean) =>
    setDraft((d) => {
      const p = projects.find((x) => x.id === d.projectId);
      return p ? withProject({ ...d, [key]: on }, p, environments) : d;
    });
  const contextOn = draft.agent.contextLimitK !== undefined;
  const ask: Task['agent']['ask'] = {
    allowed: draft.agent.ask?.allowed ?? false,
    waitMin: draft.agent.ask?.waitMin ?? 5,
  };
  const notif = draft.notifications ?? {};
  const setNotif =<K extends keyof NonNullable<Draft['notifications']>>(key: K, value: NonNullable<Draft['notifications']>[K]) =>
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
  // The agent fields as AgentFields draws them; Session type and Permission mode show their defaults.
  const agentDraft: AgentDraft = {
    environmentId: draft.environmentId ?? '',
    cwd: draft.cwd,
    harnessId: draft.agent.harnessId,
    model: draft.agent.model,
    effort: draft.agent.effort,
    mode: draft.agent.mode ?? 'interactive',
    permissionMode: draft.agent.permissionMode ?? 'auto',
  };
  const setEnvironment = (id: string) =>
    setDraft((d) => {
      const next = environments.find((e) => e.id === id);
      const p = projects.find((x) => x.id === d.projectId);
      if (p && !d.overrideAgent) return withProject({ ...d, environmentId: id }, p, environments);
      const keepHarness = d.agent.harnessId && next?.harnesses.some((h) => h.id === d.agent.harnessId);
      return { ...d, environmentId: id, agent: { ...d.agent, harnessId: keepHarness ? d.agent.harnessId : undefined } };
    });

  /** Throws when the extra-arguments or env line is malformed. */
  function assemble(): Record<string, unknown> {
    const parsed = parseArgsEnv({ label: 'Extra command-line arguments', text: extraArgsText }, { label: 'Extra environment variables', text: envText });
    if ('problem' in parsed) throw new Error(parsed.problem);
    const argsProblem = isClaude ? claudeArgsProblem(parsed.args, 'Extra command-line arguments') : null;
    if (argsProblem) throw new Error(argsProblem);
    return {
      ...draft,
      id: draft.id?.trim() || slugify(draft.name),
      env: parsed.env,
      // A step turned off with nothing configured is dropped rather than saved empty.
      check: draft.check && (checkOn || (draft.check.command ?? '').trim()) ? draft.check : undefined,
      classifier: draft.classifier && (clsOn || (draft.classifier.prompt ?? '').trim()) ? draft.classifier : undefined,
      // An empty seeded config (schedule/watcher for the unselected mode) is
      // dropped rather than saved, mirroring the check/classifier steps above.
      trigger: {
        ...trig,
        schedule: trig.schedule?.cron ? trig.schedule : undefined,
        watcher: trig.watcher?.command?.trim() ? trig.watcher : undefined,
      },
      agent: {
        ...draft.agent,
        command: draft.agent.command?.trim() || undefined,
        extraArgs: parsed.args,
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
    // A new item (or an import saved as new) gets its id from the name; saving
    // must never replace another item that already has that id.
    const derivedId = !draft.id?.trim();
    if (derivedId && typeof obj.id === 'string') {
      const items = mode === 'template' ? await window.looper.templates.list() : await window.looper.tasks.list();
      const taken = new Set(items.map((t) => t.id));
      let id = obj.id;
      for (let n = 2; taken.has(id); n++) id = `${obj.id}-${n}`;
      obj = { ...obj, id };
    }
    const v = validateTask(obj, environments, host, mode === 'template' ? { template: true } : undefined);
    if (!v.ok) {
      void window.looper.showError(mode === 'template' ? "Can't save the template." : "Can't save the task.", v.errors.join('\n'));
      return false;
    }
    if (mode === 'template') await window.looper.templates.save(v.task);
    else await window.looper.tasks.save(v.task, builderId ? { builderId } : undefined);
    // Later Apply/Save clicks in this window update the item just created.
    if (derivedId) setDraft((d) => ({ ...d, id: v.task.id }));
    return true;
  };
  const save = () => saver.save(doSave, onSaved);
  const apply = () => void saver.apply(doSave);

  useDialogKeys<EditorTab>({ tabs: TABS.map(([id]) => id), tab, onTab: switchTab });

  return (
    <div className="editor">
      <TabBar tabs={TABS} active={tab} onSelect={switchTab} className="editor-tabs" label="Task" sections>
      <div className="editor-body">
        <div className={`editor-panel${tab !== 'general' ? ' hidden' : ''}`}>
          <div className="form">
            <FormGroup>
              <Field label="Task name">
                <TextInput autoFocus value={draft.name} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <FieldRow>
                <Field label="Status">
                  <SelectInput
                    value={status}
                    onChange={(e) => setStatus(e.target.value as 'enabled' | 'disabled' | 'completed')}
                  >
                    <option value="enabled">Enabled</option>
                    <option value="disabled">Disabled</option>
                    <option value="completed" disabled={!completion.allowed && !draft.completedAt}>
                      Completed
                    </option>
                  </SelectInput>
                </Field>
              </FieldRow>
              <CheckboxField label="Allow this task to be marked completed" checked={completion.allowed ?? false} onChange={(on) => setCompletion('allowed', on)} />
            </FormGroup>
            <FormGroup>
              <Field label="Project">
                <SelectInput value={project?.id ?? ''} onChange={(e) => pickProject(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value="">New project</option>
                </SelectInput>
              </Field>
              {/* A project's folder is the project's: shown, not edited. */}
              <AgentFields
                draft={agentDraft}
                environments={envChoices}
                host={host}
                harnesses="any"
                fields={['cwd']}
                lockCwd={!!project}
                onChange={(p) => p.cwd !== undefined && set('cwd', p.cwd)}
              />
              {project && (
                <CheckboxField
                  label="Override the project's environment"
                  checked={!!draft.overrideEnvironment}
                  onChange={(on) => setOverride('overrideEnvironment', on)}
                />
              )}
              {/* Under a project the environment is the project's unless overridden: it hangs under the checkbox. */}
              <StepFields when={!!project} on={!!draft.overrideEnvironment}>
                <AgentFields
                  draft={agentDraft}
                  environments={envChoices}
                  host={host}
                  harnesses="any"
                  fields={['environment']}
                  pick={{ environment: setEnvironment }}
                  onChange={() => undefined}
                />
              </StepFields>
            </FormGroup>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'trigger' ? ' hidden' : ''}`}>
          <div className="form">
            <FormGroup>
              <Field label="Run this task">
                <SelectInput value={trigMode} onChange={(e) => setTriggerMode(e.target.value as 'manual' | 'schedule' | 'watcher')}>
                  <option value="manual">Manually only</option>
                  <option value="schedule">On a schedule</option>
                  <option value="watcher">On events</option>
                </SelectInput>
              </Field>
              {trigMode === 'schedule' && (
                <>
              <Field label="Frequency">
                <SelectInput
                  value={schedForm.mode === 'minutes' || schedForm.mode === 'hours' ? 'every' : schedForm.mode}
                  onChange={(e) => setScheduleMode(e.target.value as 'every' | CronForm['mode'])}
                >
                  <option value="every">Every…</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="custom">Custom</option>
                </SelectInput>
              </Field>
                {(schedForm.mode === 'minutes' || schedForm.mode === 'hours') && (
                  <Field label="Every">
                    <InputRow>
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
                        label="Minutes"
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
                    </InputRow>
                  </Field>
                )}
                {schedForm.mode === 'monthly' && (
                  <Field label="Days of month">
                    <ToggleButtons wrap options={MONTH_DAYS} value={schedForm.days} onChange={(days) => setSchedule({ ...schedForm, days })} />
                  </Field>
                )}
                {(schedForm.mode === 'weekly' || schedForm.mode === 'monthly') && (
                  <Field label="At">
                    <TextInput
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
                  <ActiveHours
                    value={schedForm.from !== undefined && schedForm.to !== undefined ? { from: schedForm.from, to: schedForm.to } : undefined}
                    onChange={(h) => setSchedule({ ...schedForm, from: h?.from, to: h?.to })}
                  />
                  <Field label="On days">
                    <ToggleButtons options={WEEKDAYS} value={constraintDays} onChange={(days) => setSchedule({ ...schedForm, days: days.length === 7 ? undefined : days })} />
                  </Field>
                </>
              )}
              {schedForm.mode === 'daily' && (
                <Field label="At">
                  <div className="time-chip-row">
                    {schedForm.times.map((t, i) => (
                      <span key={i} className="time-chip">
                        <TextInput
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
                  <ToggleButtons options={WEEKDAYS} value={schedForm.days} onChange={(days) => setSchedule({ ...schedForm, days })} />
                </Field>
              )}
              {schedForm.mode === 'custom' && (
                <Field label="Cron expression">
                  <TextInput
                    code
                    value={cronExpr}
                    onChange={(e) => set('trigger', { ...trig, schedule: { ...trig.schedule, cron: e.target.value } })}
                    onBlur={(e) => setBlurredCron(e.target.value)}
                  />
                  {cronError && cronExpr === blurredCron && (
                    <p className="help warn">Incorrect cron expression: {cronError}</p>
                  )}
                </Field>
              )}
              <Field label="Time zone">
                <TimezoneSelect
                  value={trig.schedule?.timezone}
                  onChange={(tz) => set('trigger', { ...trig, schedule: { ...trig.schedule, cron: cronExpr, timezone: tz } })}
                />
              </Field>
                </>
              )}
              {trigMode === 'watcher' && (() => {
                const watcher = trig.watcher;
                const setWatcher = (patch: Partial<NonNullable<NonNullable<Draft['trigger']>['watcher']>>) =>
                  set('trigger', { ...trig, watcher: { command: '', debounceSec: 5, ...watcher, ...patch } });
                const watcherDays = watcher?.days ?? ALL_DAYS;
                const hours = watcher?.activeHours;
                return (
                <>
                  <FieldRow>
                    <Field label="Watcher command">
                      <TextInput
                        code
                        value={watcher?.command ?? ''}
                        onChange={(e) => setWatcher({ command: e.target.value })}
                      />
                    </Field>
                    <NumberField
                      label="Batch events for"
                      suffix="s"
                      min={0}
                      value={watcher?.debounceSec ?? 5}
                      onChange={(n) => setWatcher({ debounceSec: n })}
                    />
                  </FieldRow>
                  <InlineField>
                    <CheckboxField
                      label="Don’t hold an event longer than"
                      checked={watcher?.maxWaitSec !== undefined}
                      onChange={(on) => setWatcher({ maxWaitSec: on ? DEFAULT_MAX_WAIT_SEC : undefined })}
                    />
                    <NumberInput
                      label="Longest an event is held"
                      suffix="s"
                      min={0}
                      disabled={watcher?.maxWaitSec === undefined}
                      value={watcher?.maxWaitSec ?? DEFAULT_MAX_WAIT_SEC}
                      onChange={(n) => setWatcher({ maxWaitSec: n })}
                    />
                  </InlineField>
                  <CheckboxField
                    label="Run once when watching starts, to catch up on missed events"
                    checked={watcher?.runOnStart ?? false}
                    onChange={(on) => setWatcher({ runOnStart: on })}
                  />
                  <ActiveHours value={hours} onChange={(h) => setWatcher({ activeHours: h })} />
                  <Field label="On days">
                    <ToggleButtons options={WEEKDAYS} value={watcherDays} onChange={(days) => setWatcher({ days: days.length === 7 ? undefined : days })} />
                  </Field>
                  {(hours || watcher?.days) && (
                    <Field label="Time zone">
                      <TimezoneSelect value={watcher?.timezone} onChange={(tz) => setWatcher({ timezone: tz })} />
                    </Field>
                  )}
                </>
                );
              })()}
            </FormGroup>
            <FormGroup>
              <CheckboxField
                label="Send new related events to the running agent"
                note={`Events are related when they have the same ${RELATED_ID_FIELD}.`}
                checked={trig.sendRelatedEvents ?? false}
                onChange={(on) => set('trigger', { ...trig, sendRelatedEvents: on })}
              />
            </FormGroup>
            {trigMode !== 'manual' && (
              <FormGroup>
                <CheckboxField
                  label="Stop on a date"
                  checked={stopOnEnabled}
                  onChange={(on) => setStopOn({ enabled: on, at: stopOn?.at ?? defaultStopOn() })}
                />
                <StepFields on={stopOnEnabled}>
                  <Field label="Stop running on">
                    <TextInput
                      type="datetime-local"
                      value={toLocalInput(stopOn?.at)}
                      onChange={(e) => setStopOn({ enabled: true, at: fromLocalInput(e.target.value) ?? stopOn!.at })}
                    />
                  </Field>
                </StepFields>
              </FormGroup>
            )}
          </div>
        </div>

        <div className={`editor-panel${tab !== 'check' ? ' hidden' : ''}`}>
          <div className="form">
            <FormGroup>
              <CheckboxField
                label="Run a command to check whether the agent should run"
                checked={checkOn}
                onChange={(on) => set('check', { ...(draft.check ?? { command: '', timeoutSec: 60 }), enabled: on })}
              />
              <StepFields on={checkOn}>
                <Field label="Command">
                  <TextInput code value={draft.check?.command ?? ''} onChange={(e) => setCheck('command', e.target.value)} />
                </Field>
                <NumberField label="Timeout" suffix="s" min={1} value={draft.check?.timeoutSec ?? 60} onChange={(n) => setCheck('timeoutSec', n)} />
              </StepFields>
            </FormGroup>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'classifier' ? ' hidden' : ''}`}>
          <div className="form">
            <FormGroup>
              <CheckboxField
                label="Ask a model whether the agent should run"
                checked={clsOn}
                onChange={(on) => set('classifier', { ...(draft.classifier ?? EXAMPLE_TASK.classifier!), enabled: on })}
              />
              {(() => {
                const cls = draft.classifier;
                // No pin: the harness the engine falls back to (resolveClassifierHarness), the
                // agent's own unless it's custom, then the first non-custom one.
                const agentHarness = harnesses.find((h) => h.id === draft.agent.harnessId) ?? harnesses[0];
                const clsHarness =
                  harnesses.find((h) => h.id === cls?.harnessId) ??
                  (agentHarness && agentHarness.kind !== 'custom' ? agentHarness : harnesses.find((h) => h.kind !== 'custom')) ??
                  harnesses[0];
                /** Model ids don't carry across harnesses: the model stays when the new harness has it, else its first preset. */
                const pickClsHarness = (id: string) => {
                  const h = harnesses.find((x) => x.id === id);
                  const presets = h ? harnessModels(h) : [];
                  const cur = draft.classifier?.model;
                  const model = cur && presets.some((m) => m.id === cur) ? cur : (presets[0]?.id ?? cur ?? 'haiku');
                  setCustomClsModel(false);
                  set('classifier', { ...draft.classifier!, harnessId: id, model });
                };
                return (
                <StepFields on={clsOn}>
                  <AgentFields
                    // An unset model runs the schema's haiku; with Custom… picked, the Model id box shows it empty.
                    draft={{ environmentId: draft.environmentId ?? '', cwd: draft.cwd, harnessId: cls?.harnessId, model: cls?.model ?? (customClsModel ? undefined : 'haiku'), mode: cls?.mode ?? 'headless' }}
                    environments={environments}
                    host={host}
                    harnesses="any"
                    fields={['harness', 'model', 'mode']}
                    fallbackHarness={clsHarness}
                    modelRequired
                    defaultMode="headless"
                    customModel={{ pinned: customClsModel, onPin: setCustomClsModel }}
                    pick={{ harness: pickClsHarness }}
                    // The classifier has no effort or permission mode, and its schema takes no other keys.
                    onChange={(p) =>
                      set('classifier', { ...draft.classifier!, ...('model' in p ? { model: p.model } : {}), ...(p.mode ? { mode: p.mode } : {}) })
                    }
                  />
                  <FieldRow>
                    <NumberField
                      label="Timeout"
                      suffix="s"
                      min={1}
                      value={cls?.timeoutSec ?? 180}
                      onChange={(n) => set('classifier', { ...draft.classifier!, timeoutSec: n })}
                    />
                  </FieldRow>
                  <Field
                    label="Classifier prompt"
                    help={
                      <>
                        Ask a yes/no question about the check output. <code>{'{{summary}}'}</code> and <code>{'{{context}}'}</code>{' '}
                        insert it, <code>{'{{events}}'}</code> the watcher events; if you use none they are appended automatically.{' '}
                        <code>{'{{file:path}}'}</code> inserts that file's contents.
                      </>
                    }
                  >
                    <TextArea rows={5} value={cls?.prompt ?? ''} onChange={(e) => set('classifier', { ...draft.classifier!, prompt: e.target.value })} />
                  </Field>
                </StepFields>
                );
              })()}
            </FormGroup>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'agent' ? ' hidden' : ''}`}>
          <div className="form">
            <FormGroup>
              <Field
                label="Agent prompt"
                help={
                  <>
                    <code>{'{{summary}}'}</code> and <code>{'{{context}}'}</code> insert the check output,{' '}
                    <code>{'{{events}}'}</code> the watcher events (appended automatically if you use none).{' '}
                    <code>{'{{file:path}}'}</code> inserts that file's contents.
                  </>
                }
              >
                <TextArea rows={9} value={draft.agent.prompt} onChange={(e) => setAgent('prompt', e.target.value)} />
              </Field>
            </FormGroup>
            <FormGroup>
              {project && (
                <CheckboxField label="Override the project's agent settings" checked={!!draft.overrideAgent} onChange={(on) => setOverride('overrideAgent', on)} />
              )}
              {/* The same order and rows as the Project editor; under a project they hang under the override checkbox. */}
              <StepFields when={!!project} on={!!draft.overrideAgent}>
                <AgentFields
                  draft={agentDraft}
                  environments={environments}
                  host={host}
                  harnesses="any"
                  fields={['harness', 'model', 'effort', 'mode', 'permission']}
                  customModel={{ pinned: customModel, onPin: setCustomModel }}
                  pick={{ harness: setHarness, model: pickModel }}
                  onChange={(p) => setDraft((d) => ({ ...d, agent: { ...d.agent, ...p } }))}
                />
              </StepFields>
            </FormGroup>
            {(isClaude || isCodex) && (
              <FormGroup>
                <CheckboxField
                  label="Continue one conversation across runs"
                  checked={continueOn}
                  onChange={(on) => setAgent('session', on ? 'continue' : 'fresh')}
                />
                <StepFields on={continueOn}>
                  <FieldRow>
                    <NumberField
                      label="Start a new conversation after"
                      suffix="runs"
                      min={1}
                      value={draft.agent.sessionMaxRuns ?? 10}
                      onChange={(n) => setAgent('sessionMaxRuns', n)}
                    />
                  </FieldRow>
                </StepFields>
              </FormGroup>
            )}
            <FormGroup>
              <FieldRow>
                <Field label="Command">
                  <TextInput
                    code
                    value={draft.agent.command ?? ''}
                    placeholder={harness?.command}
                    onChange={(e) => setAgent('command', e.target.value || undefined)}
                  />
                </Field>
                <Field
                  label="Extra command-line arguments"
                  help={project?.extraArgs.length ? `After the project's: ${joinTokens(project.extraArgs)}` : undefined}
                >
                  <TextInput code value={extraArgsText} onChange={(e) => setExtraArgsText(e.target.value)} />
                </Field>
                <Field
                  label="Extra environment variables"
                  help={Object.keys(project?.env ?? {}).length ? `Added to the project's: ${envToLine(project!.env)}` : undefined}
                >
                  <TextInput code value={envText} onChange={(e) => setEnvText(e.target.value)} />
                </Field>
              </FieldRow>
            </FormGroup>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'settings' ? ' hidden' : ''}`}>
          <div className="form">
            <FormGroup>
              <FieldRow>
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
              </FieldRow>
              <FieldRow>
                <NumberField
                  label="Idle grace"
                  suffix="min"
                  min={1}
                  value={draft.agent.idleGraceMin ?? 3}
                  onChange={(n) => setAgent('idleGraceMin', n)}
                />
                <Field label="When idle too long">
                  <SelectInput value={draft.agent.onIdleTimeout ?? 'finish'} onChange={(e) => setAgent('onIdleTimeout', e.target.value as 'finish' | 'hold')}>
                    <option value="finish">End the run</option>
                    <option value="hold">Hold and wait for me</option>
                  </SelectInput>
                </Field>
              </FieldRow>
              <FieldRow>
                <NumberField
                  label="Simultaneous runs"
                  suffix="runs"
                  min={1}
                  value={draft.maxConcurrentRuns ?? 1}
                  onChange={(n) => set('maxConcurrentRuns', n)}
                />
              </FieldRow>
            </FormGroup>
            {(isClaude || isCodex) && (
              <FormGroup>
                <CheckboxField
                  label="Restart the agent when its context passes a limit"
                  checked={contextOn}
                  onChange={(on) => setAgent('contextLimitK', on ? DEFAULT_CONTEXT_LIMIT_K : undefined)}
                />
                <StepFields on={contextOn}>
                  <FieldRow>
                    <NumberField
                      label="Context limit"
                      suffix="k tokens"
                      min={1}
                      value={draft.agent.contextLimitK ?? DEFAULT_CONTEXT_LIMIT_K}
                      onChange={(n) => setAgent('contextLimitK', n)}
                    />
                    <NumberField
                      label="Max restarts"
                      suffix="per run"
                      min={0}
                      value={draft.agent.maxRestarts ?? 3}
                      onChange={(n) => setAgent('maxRestarts', n)}
                    />
                  </FieldRow>
                </StepFields>
              </FormGroup>
            )}
            <FormGroup>
              <CheckboxField label="Allow the agent to ask questions" checked={ask.allowed} onChange={(on) => setAgent('ask', { ...ask, allowed: on })} />
              <StepFields on={ask.allowed}>
                <FieldRow>
                  <NumberField
                    label="Wait for an answer"
                    suffix="min"
                    min={1}
                    value={ask.waitMin}
                    onChange={(n) => setAgent('ask', { ...ask, waitMin: n })}
                  />
                </FieldRow>
              </StepFields>
              {(isClaude || isCodex) && (
                <CheckboxField
                  label="Allow the agent to start agents in other folders"
                  checked={draft.agent.delegate?.allowed ?? false}
                  onChange={(on) => setAgent('delegate', { allowed: on })}
                />
              )}
            </FormGroup>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'notifications' ? ' hidden' : ''}`}>
          <div className="form">
            <FormGroup>
              <CheckboxField label="Notify when a run starts" checked={notif.runStart ?? false} onChange={(on) => setNotif('runStart', on)} />
              <CheckboxField label="Notify when the agent starts" checked={notif.agentStart ?? false} onChange={(on) => setNotif('agentStart', on)} />
            </FormGroup>
            <FormGroup>
              <CheckboxField
                label="Notify when the task ends"
                checked={endOn}
                onChange={(on) => {
                  if (!on) setRememberedEnd(endLevel);
                  setNotif('end', on ? endLevel : 'off');
                }}
              />
              <StepFields on={endOn}>
                <RadioField
                  label="Notify when the task ends"
                  hideLabel
                  name="notif-end"
                  value={endLevel}
                  options={[
                    ['error', 'With an error'],
                    ['warning', 'With an error or warning'],
                    ['end', 'With any result except no action'],
                    ['all', 'With any result'],
                  ]}
                  onChange={(value) => {
                    setRememberedEnd(value);
                    setNotif('end', value);
                  }}
                />
                <CheckboxField label="Include network errors" checked={notif.networkErrors ?? false} onChange={(on) => setNotif('networkErrors', on)} />
                <CheckboxField label="Include environment errors" checked={notif.environmentErrors ?? false} onChange={(on) => setNotif('environmentErrors', on)} />
              </StepFields>
            </FormGroup>
            <FormGroup>
              <CheckboxField label="Notify when the agent holds and waits for input" checked={notif.held ?? false} onChange={(on) => setNotif('held', on)} />
              <CheckboxField label="Notify when the task auto-pauses" checked={notif.autoPaused ?? false} onChange={(on) => setNotif('autoPaused', on)} />
              <CheckboxField label="Notify when the task completes" checked={notif.completed ?? false} onChange={(on) => setNotif('completed', on)} />
              <CheckboxField label="Notify when the usage limit is reached" checked={notif.usageLimit ?? false} onChange={(on) => setNotif('usageLimit', on)} />
            </FormGroup>
          </div>
        </div>

        <div className={`editor-panel${tab !== 'json' ? ' hidden' : ''}`}>
          <TextArea code className="json-editor" aria-label="Task JSON" value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
        </div>
      </div>
      </TabBar>
      <WindowActions confirm={{ label: 'Save', run: save }} cancel={onCancel} apply={{ run: apply }} busy={saver.busy} />
    </div>
  );
}
