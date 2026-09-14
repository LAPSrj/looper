import type { TaskInput } from './types';

/**
 * Every user-settable field, spelled out with its JSON value. The app-managed
 * stamps (completedAt, completedReason, createdAt, updatedAt) are left out:
 * Looper writes those itself.
 */
export const EXAMPLE_TASK: TaskInput = {
  id: 'issues-triage',
  name: 'Issues triage',
  enabled: true,
  completion: { allowed: false },
  // Sidebar folder id; a task pointing at no existing folder lists at the top level.
  folderId: 'my-folder',
  // What starts runs: 'manual' (only Run Now), 'schedule' (cron slots), or
  // 'watcher' (a long-running command whose stdout lines trigger runs). The
  // unselected mode's configuration is kept, like a disabled step keeps its fields.
  trigger: {
    mode: 'schedule',
    schedule: { cron: '*/10 * * * *', timezone: 'UTC' },
    watcher: { command: 'node scripts/watch-events.js', debounceSec: 5 },
    stopOn: { enabled: false, at: '2027-01-01T09:00:00' },
  },
  environmentId: 'local',
  cwd: '/home/me/repos/project',
  env: {},
  check: {
    enabled: true,
    command: 'node scripts/looper-check.js',
    timeoutSec: 60,
  },
  classifier: {
    enabled: true,
    harnessId: 'claude',
    model: 'haiku',
    mode: 'headless',
    prompt:
      'Decide whether the agent should act now. Say yes only if the items below represent real work that needs handling. Ignore noise, duplicates, and items that need no action.\n\nSummary: {{summary}}\n\n{{context}}',
    timeoutSec: 180,
  },
  agent: {
    harnessId: 'claude',
    model: 'sonnet',
    mode: 'interactive',
    session: 'fresh',
    sessionMaxRuns: 10,
    permissionMode: 'auto',
    prompt:
      'Handle the pending items for this project.\n\nSummary: {{summary}}\n\nDetails:\n{{context}}\n\nWork through them one by one, commit as you go, and finish by running `looper-done <status> "<headline>"` followed by a closing message that reports what you did.',
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
  },
  note: { text: 'One-off guidance appended to the next run(s); consumed as runs use it.', runsLeft: 1 },
};

export const EXAMPLE_CHECK_SCRIPT = `#!/usr/bin/env bash
# Looper check-script contract: the LAST line of stdout must be JSON:
#   {"act": true|false, "summary": "one line", "context": <anything>}
# Non-zero exit / timeout / non-JSON last line = error (never a trigger).
count=$(gh issue list --label bug --json number --jq 'length' 2>/dev/null || echo 0)
if [ "$count" -gt 0 ]; then
  items=$(gh issue list --label bug --json number,title)
  printf '{"act": true, "summary": "%s open bug issues", "context": %s}\\n' "$count" "$items"
else
  echo '{"act": false, "summary": "no open bugs"}'
fi
`;
