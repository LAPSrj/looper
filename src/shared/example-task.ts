import type { TaskInput } from './types';

export const EXAMPLE_TASK: TaskInput = {
  id: 'issues-triage',
  name: 'Issues triage',
  enabled: true,
  schedule: { cron: '*/10 * * * *' },
  environmentId: 'local',
  cwd: '/home/me/repos/project',
  check: {
    command: 'node scripts/looper-check.js',
    timeoutSec: 60,
  },
  classifier: {
    model: 'haiku',
    prompt:
      'Decide whether the agent should act now. Say yes only if the items below represent real work that needs handling. Ignore noise, duplicates, and items that need no action.\n\nSummary: {{summary}}\n\n{{context}}',
  },
  agent: {
    model: 'sonnet',
    mode: 'interactive',
    permissionMode: 'auto',
    prompt:
      'Handle the pending items for this project.\n\nSummary: {{summary}}\n\nDetails:\n{{context}}\n\nWork through them one by one, commit as you go, and finish by running `looper-done "<one line summary>"`.',
    extraArgs: [],
    maxRuntimeMin: 90,
    idleGraceMin: 3,
    onIdleTimeout: 'finish',
  },
  backoff: { maxConsecutiveErrors: 5 },
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
