# Creating a Looper task

A task tells Looper what to watch, how to decide whether to act, and what agent
to start when it does. You define it as a JSON file and hand it to the CLI or
drop it into the inbox.

## Lifecycle

```
IDLE ──schedule──▶ CHECKING ──act:false──▶ IDLE
CHECKING ──act:true──▶ [CLASSIFYING ──no──▶ IDLE] ──yes──▶ RUNNING ──done──▶ IDLE
```

1. **Check** — a shell command runs on a schedule. Its last stdout line must be
   JSON: `{"act": true, "summary": "...", "context": ...}`. Non-zero exit,
   timeout, or non-JSON output is an error, never a trigger.
2. **Classify** (optional) — a cheap model (`haiku` by default) reads the
   summary/context and decides `{act: true/false, reason: "..."}`. Saves a
   full agent invocation when the check fires but the signal is noise.
3. **Agent** — a fresh Claude Code / Codex / custom CLI session starts with
   your prompt. The check output is available as template variables. The agent
   calls `looper-done "summary"` when finished (interactive mode) or just
   exits (headless mode).

## Submitting a task

```bash
looper add task.json          # validates and drops into the inbox
```

Or write the JSON file directly into `$LOOPER_HOME/inbox/` (the running app
polls it). To send a command instead of a task definition:

```json
{"op": "run", "taskId": "my-task"}
```

Valid ops: `run`, `pause`, `resume`, `stop`, `remove`, `enable`, `disable`.

## Generating a starting point

```bash
looper example              # prints a valid task JSON to stdout
looper example --script     # prints an example check script
```

## Task JSON reference

Every field below is documented with its type, default, and meaning. Fields
marked **(required)** have no default.

### Top level

| Field | Type | Default | Description |
|---|---|---|---|
| `id` | string | **(required)** | Unique identifier. Letters, digits, `-` and `_` only. |
| `name` | string | **(required)** | Human-readable name shown in the UI. |
| `enabled` | boolean | `true` | Whether the schedule is active. |
| `schedule` | object | **(required)** | See [Schedule](#schedule). |
| `environmentId` | string | **(required)** | Which environment to run in (see [Environments](#environments-and-harnesses)). |
| `cwd` | string | **(required)** | Working directory in the environment's native path style (`/home/...` or `C:\...`). |
| `check` | object | **(required)** | See [Check](#check). |
| `classifier` | object | *(omit to skip)* | See [Classifier](#classifier). |
| `agent` | object | **(required)** | See [Agent](#agent). |
| `backoff` | object | `{}` | See [Backoff](#backoff). |

### Schedule

```json
{ "cron": "*/10 * * * *" }
```

Standard 5-field cron expression (minute, hour, day-of-month, month,
day-of-week). Parsed by [croner](https://github.com/hexagon/croner). A slot
that passes while the task is busy is logged as skipped, never overlapped.

Common patterns:

| Cron | Meaning |
|---|---|
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour on the hour |
| `0 9-17 * * 1-5` | Every hour, 9 AM–5 PM, weekdays |
| `30 9 * * *` | Daily at 9:30 AM |
| `0 0 1 * *` | First of each month at midnight |

### Check

| Field | Type | Default | Description |
|---|---|---|---|
| `command` | string | **(required)** | Shell command to run. Executed in `cwd` inside the task's environment. |
| `timeoutSec` | number | `60` | Kill the check if it takes longer. |

**Contract:** the last non-empty line of stdout must be a JSON object with a
boolean `act` field. Optional fields: `summary` (string) and `context`
(anything — string, object, array).

```json
{"act": true, "summary": "3 new issues", "context": [{"number": 42, "title": "Bug in parser"}]}
```

`{"act": false, "summary": "nothing to do"}` — no agent starts.

Non-zero exit code = error (the task records it and increments the consecutive
error counter). Never use a non-zero exit to mean "nothing to do" — use
`{"act": false}` for that.

### Classifier

Omit this section entirely to skip classification (check `act: true` goes
straight to the agent).

| Field | Type | Default | Description |
|---|---|---|---|
| `harnessId` | string | *(auto)* | Which Claude Code harness to use. Auto = the task's own harness if it's Claude Code, else the environment's first Claude Code harness. |
| `model` | string | `"haiku"` | Model for the classifier call. |
| `prompt` | string | **(required)** | Prompt template (see [Template variables](#template-variables)). |
| `timeoutSec` | number | `180` | Kill the classifier if it takes longer. |

The classifier is always run headless (`claude -p`) and must return
`{"act": boolean, "reason": string}` via structured output. Looper handles
the schema and invocation; you only write the prompt.

### Agent

| Field | Type | Default | Description |
|---|---|---|---|
| `harnessId` | string | *(first harness)* | Harness from the task's environment. Empty = the environment's first harness. |
| `model` | string | *(CLI default)* | Passed as `--model`. Empty = whatever the CLI defaults to. |
| `prompt` | string | **(required)** | Prompt template (see [Template variables](#template-variables)). |
| `mode` | `"interactive"` or `"headless"` | `"interactive"` | Interactive runs in a pty you can type into; headless runs `claude -p` / `codex exec`. |
| `permissionMode` | string | `"auto"` | Claude Code only: passed as `--permission-mode`. Empty string omits the flag. |
| `extraArgs` | string[] | `[]` | Appended verbatim to the harness command line. |
| `maxRuntimeMin` | number | `120` | Hard cap on the agent run in minutes. |
| `idleGraceMin` | number | `3` | Minutes the agent may sit idle (finished a turn without calling `looper-done`) before the run ends or is held. |
| `onIdleTimeout` | `"finish"` or `"hold"` | `"finish"` | `finish` ends the run; `hold` pauses it for a human to intervene via the terminal tab. |

Looper injects a system prompt footer telling the agent it's a one-shot
unattended session and instructing it to call `looper-done "<summary>"` when
finished (interactive mode) or end with a summary line (headless mode). You
don't need to repeat that in your prompt.

### Backoff

| Field | Type | Default | Description |
|---|---|---|---|
| `maxConsecutiveErrors` | number | `5` | Auto-pause the task after this many consecutive failed cycles. |

### Template variables

Prompts (both classifier and agent) support `{{variable}}` placeholders.
Available variables:

| Variable | Value |
|---|---|
| `{{task}}` | The task's `name`. |
| `{{taskId}}` | The task's `id`. |
| `{{runId}}` | The current run ID. |
| `{{trigger}}` | What started the cycle: `"timer"` (scheduled) or `"manual"` (via `looper run`). |
| `{{summary}}` | The `summary` string from the check output. |
| `{{context}}` | The `context` value from the check output (objects are pretty-printed as JSON). |

If your prompt does not contain `{{summary}}` or `{{context}}`, Looper appends
the check output automatically under a `## Check output` heading so the agent
always sees it.

## Environments and harnesses

A task runs in an **environment** — the local shell, a WSL distro, or native
Windows. Each environment has one or more **harnesses**: installed agent CLIs
(Claude Code, Codex, or a custom command).

To see what's configured, open **Settings → Environments** in the app. From the
CLI there is no list command yet, but you can read `settings.json` in the data
directory (`looper home` prints the path):

```bash
cat "$(looper home)/settings.json"
```

The default setup creates a `"local"` environment with a `"claude"` harness
(Claude Code). If Looper detects WSL or Windows, it adds the bridge environment
automatically.

When writing a task JSON:
- Set `environmentId` to the environment's `id` (e.g. `"local"`, `"wsl"`).
- Set `agent.harnessId` to a harness `id` within that environment, or omit it
  to use the environment's first harness.

## Example: GitHub issues triage

```json
{
  "id": "issues-triage",
  "name": "Issues triage",
  "enabled": true,
  "schedule": { "cron": "*/10 * * * *" },
  "environmentId": "local",
  "cwd": "/home/me/repos/project",
  "check": {
    "command": "bash scripts/check-issues.sh",
    "timeoutSec": 60
  },
  "classifier": {
    "model": "haiku",
    "prompt": "Decide whether the agent should act now. Say yes only if the items below represent real work that needs handling. Ignore noise, duplicates, and items that need no action.\n\nSummary: {{summary}}\n\n{{context}}"
  },
  "agent": {
    "model": "sonnet",
    "mode": "interactive",
    "permissionMode": "auto",
    "prompt": "Handle the pending items for this project.\n\nSummary: {{summary}}\n\nDetails:\n{{context}}\n\nWork through them one by one, commit as you go.",
    "maxRuntimeMin": 90,
    "idleGraceMin": 3,
    "onIdleTimeout": "finish"
  },
  "backoff": { "maxConsecutiveErrors": 5 }
}
```

## Example check script

```bash
#!/usr/bin/env bash
# Last line of stdout must be JSON with a boolean "act" field.
count=$(gh issue list --label bug --json number --jq 'length' 2>/dev/null || echo 0)
if [ "$count" -gt 0 ]; then
  items=$(gh issue list --label bug --json number,title)
  printf '{"act": true, "summary": "%s open bug issues", "context": %s}\n' "$count" "$items"
else
  echo '{"act": false, "summary": "no open bugs"}'
fi
```

## Tips

- **Every run is a fresh session.** No context accumulates between runs. Put
  anything the agent should know across runs in the project's `CLAUDE.md`.
- **Use the classifier to save costs.** A Haiku call costs a fraction of a
  full agent session. If your check script fires often but only some signals
  need action, the classifier filters cheaply.
- **Test your check script standalone.** Run it by hand and verify the last
  line is valid JSON with `"act": true` or `false`. Looper treats non-JSON
  and non-zero exits as errors, not triggers.
- **Start with `onIdleTimeout: "hold"`** while developing. This lets you see
  what the agent got stuck on instead of silently ending the run.
- **`looper-done` is on PATH** inside every agent session. The agent doesn't
  need to know where it lives — just `looper-done "what I did"`.
