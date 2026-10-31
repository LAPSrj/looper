import type { TaskInput } from '../../../shared/types';

export type Draft = TaskInput & {
  agent: NonNullable<TaskInput['agent']>;
};

/**
 * What a new task starts with, spelled out. Not a copy of the documentation's
 * example task, which carries a one-off guidance note and a folder that no new
 * task should get: a new task has no note and no folder.
 */
export function blankDraft(environmentId?: string): Draft {
  return {
    id: '',
    name: '',
    enabled: true,
    completion: { allowed: false },
    trigger: {
      mode: 'schedule',
      schedule: { cron: '*/10 * * * *', timezone: 'UTC' },
      watcher: {
        command: 'node scripts/watch-events.js',
        debounceSec: 5,
        runOnStart: false,
        activeHours: { from: 7, to: 22 },
        days: [1, 2, 3, 4, 5],
        timezone: 'UTC',
      },
      stopOn: { enabled: false, at: '2027-01-01T09:00:00' },
    },
    environmentId: environmentId ?? '',
    cwd: '',
    env: {},
    check: { enabled: true, command: '', timeoutSec: 60 },
    agent: {
      harnessId: 'claude',
      model: 'sonnet',
      mode: 'interactive',
      session: 'fresh',
      sessionMaxRuns: 10,
      permissionMode: 'auto',
      prompt: '',
      extraArgs: [],
      maxRuntimeMin: 90,
      idleGraceMin: 3,
      onIdleTimeout: 'finish',
    },
    backoff: { maxConsecutiveErrors: 5 },
    maxConcurrentRuns: 1,
    notifications: {
      runStart: false,
      agentStart: false,
      end: 'warning',
      held: false,
      autoPaused: false,
      completed: false,
      usageLimit: false,
      networkErrors: false,
      environmentErrors: false,
    },
  } as Draft;
}
