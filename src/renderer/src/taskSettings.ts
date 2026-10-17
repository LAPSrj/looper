import { describeCron } from '@shared/cron';
import { EFFORT_LEVELS, PERMISSION_MODES, harnessModels } from '@shared/environments';
import type { Environment, Harness } from '@shared/types';
import { changeLabel } from '@shared/versions';
import { fmtDateTime } from './format';

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);

/** The task editor's tab a setting is on, for the group headers of a settings list. */
export function settingGroup(path: string): string {
  const top = path.split('.')[0];
  switch (top) {
    case 'trigger':
      return 'Trigger';
    case 'check':
      return 'Check';
    case 'classifier':
      return 'Classifier';
    case 'agent':
      return 'Agent';
    case 'notifications':
      return 'Notifications';
    default:
      return 'General';
  }
}

/** A setting's label as the editor shows it; an environment variable by its name. */
export function settingLabel(path: string): string {
  if (path.startsWith('env.')) return `Environment variable ${path.slice(4)}`;
  return changeLabel(path);
}

/** The editor's words for each choice of a select. */
const CHOICES: Record<string, Record<string, string>> = {
  'trigger.mode': { manual: 'Manually only', schedule: 'On a schedule', watcher: 'On events' },
  'agent.mode': { interactive: 'Interactive terminal', headless: 'Headless' },
  'classifier.mode': { interactive: 'Interactive terminal', headless: 'Headless' },
  'agent.session': { fresh: 'Start new on each run', continue: 'Continue previous across runs' },
  'agent.onIdleTimeout': { finish: 'End the run', hold: 'Hold and wait for me' },
  'notifications.end': {
    off: 'No',
    error: 'With an error',
    warning: 'With an error or warning',
    end: 'With any result except no action',
    all: 'With any result',
  },
};

function harnessOf(def: Rec, path: string, environments: Environment[]): Harness | undefined {
  const env = environments.find((e) => e.id === def.environmentId);
  if (!env) return undefined;
  const section = obj(def[path.startsWith('classifier.') ? 'classifier' : 'agent']);
  const id = section?.harnessId;
  return env.harnesses.find((h) => h.id === id) ?? (id ? undefined : env.harnesses[0]);
}

/**
 * A setting's value on one line, in the editor's words: choices by their
 * labels, ids by names, durations with their unit. undefined = it doesn't fit
 * a line (a prompt, a script).
 */
export function settingValue(path: string, v: unknown, def: Rec, environments: Environment[]): string | undefined {
  if (v === undefined) return 'Not set';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const choice = CHOICES[path]?.[String(v)];
  if (choice) return choice;
  if (path === 'trigger.schedule.cron' && typeof v === 'string') return describeCron(v);
  if (path === 'trigger.stopOn.at' && typeof v === 'string') return fmtDateTime(v);
  if (path === 'environmentId') return environments.find((e) => e.id === v)?.name ?? String(v);
  const harness = path.endsWith('.harnessId') || path.endsWith('.model') || path === 'agent.effort' || path === 'agent.permissionMode'
    ? harnessOf(def, path, environments)
    : undefined;
  const kind = harness?.kind;
  if (path.endsWith('.harnessId')) return harness?.name ?? String(v);
  if (path.endsWith('.model') && harness) return harnessModels(harness).find((m) => m.id === v)?.name ?? String(v);
  if (path === 'agent.effort' && kind && kind !== 'custom') return EFFORT_LEVELS[kind].find(([x]) => x === v)?.[1] ?? String(v);
  if (path === 'agent.permissionMode' && kind && kind !== 'custom') return PERMISSION_MODES[kind].find(([x]) => x === v)?.[1] ?? String(v);
  if (typeof v === 'number') {
    if (path.endsWith('Sec')) return `${v} s`;
    if (path.endsWith('Min')) return `${v} min`;
    if (path === 'agent.sessionMaxRuns') return v === 1 ? '1 run' : `${v} runs`;
    if (path === 'backoff.maxConsecutiveErrors') return v === 1 ? '1 error in a row' : `${v} errors in a row`;
    return String(v);
  }
  if (Array.isArray(v)) return v.length === 0 ? 'None' : v.map(String).join(', ');
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.includes('\n') || s.length > 60 ? undefined : s;
}
