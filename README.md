# Looper

Cron-style manager for AI agent loops.

An agent that polls for work burns tokens and context on every idle check, and
its conversation eventually fills up and gets compacted. Looper flips that
around: a **cheap script** polls on a schedule, an optional **cheap classifier
model** decides whether the result is worth acting on, and only then a **fresh
`claude` session** is started in a terminal you can watch (and type into). When
the agent is done it signals Looper, the session closes, and the loop resumes.
At most one agent runs per task, ever.

Main use case: Looper runs on Windows, the agents run inside WSL. It also runs
inside WSL/Linux directly, and can drive native Windows PowerShell agents.

## How a task runs

```
IDLE ──schedule──▶ CHECKING ──act:false──▶ IDLE
CHECKING ──act:true──▶ [CLASSIFYING ──no──▶ IDLE] ──yes──▶ RUNNING ──done──▶ IDLE
```

1. **Check** — your script runs in the task's directory. The last line of its
   stdout must be JSON: `{"act": true, "summary": "3 new issues", "context": {…}}`.
   Non-zero exit, timeout or non-JSON output is an **error**, never a trigger.
2. **Classify** (optional) — `claude -p --model haiku` gets the summary/context
   and answers `{act, reason}` under a strict schema and a dollar budget.
3. **Agent** — `claude` starts in the task's directory with your prompt (the
   check output is templated in via `{{summary}}` / `{{context}}`, or appended
   if you don't reference them). Interactive by default, in a real pty shown in
   Looper's terminal tab. The run ends on the first of:
   - the agent runs `looper-done "summary"` (its instructions say to),
   - it sits idle after a turn longer than `idleGraceMin` without signalling
     (a `Stop` hook Looper injects reports idleness) — ends the run, or holds
     it for a human if `onIdleTimeout: "hold"`,
   - the claude process exits, or
   - `maxRuntimeMin` is exceeded.

   `mode: "headless"` uses `claude -p` instead: process exit is the signal,
   nothing to type into.

Every run is a fresh session — no context accumulation, no compaction. Put
anything the agent must remember between runs in the project's `CLAUDE.md`.

`every` intervals count from the **end** of the previous cycle. `cron`
schedules keep wall-clock slots; a slot that passes while a cycle is busy is
logged as skipped, never overlapped.

## Install / run

No compiler toolchain needed on any platform: node-pty ships N-API prebuilds
(win32/linux/mac), which work in both Node and Electron as-is.

```bash
npm install
npm run dev            # Electron app with hot reload
npm run build:all      # out/ (app) + dist/cli.js
npm run package        # Windows installer/portable in release/
npm test               # engine unit tests
```

CLI (after `npm run build:cli`; `npm link` to get `looper` on PATH):

```bash
looper example > task.json      # template; `looper example --script` for a check script
looper add task.json            # register (drops into the inbox; the app picks it up)
looper list
looper run|pause|resume|stop|remove|enable|disable <taskId>
looper logs <taskId> -n 50
looper serve                    # run the engine in a terminal without the UI
looper home                     # print the data directory
```

The CLI talks to the running app through the **inbox directory** (JSON drop
folder), so it works from inside WSL against a Looper running on Windows:

```bash
export LOOPER_HOME=/mnt/c/Users/<you>/AppData/Roaming/looper
looper add my-task.json
```

Agents can register tasks the same way — write a task JSON into
`$LOOPER_HOME/inbox/`. Files with `{"op": "run", "taskId": "…"}` are commands.

## Data directory

Windows: `%APPDATA%\looper` · Linux/WSL: `~/.config/looper` · override with
`LOOPER_HOME`.

```
settings.json          # defaultDistro, wslMountPrefix, claudeCommand, autoTrustWorkspace, …
tasks.json
state.json             # runtime snapshot (for the CLI and crash recovery)
engine.log
inbox/                 # + processed/ rejected/
tasks/<id>/runs.jsonl  # one record per phase per run
tasks/<id>/runs/<runId>/
  check.sh|ps1  check.out.txt  check.err.txt
  classify.sh   classify-prompt.txt  classify.out.txt
  run.sh|ps1    prompt.txt  system.txt  settings.json
  output.log    # raw terminal capture of the agent session
  idle  done    # signal files
  bin/looper-done
```

Every step runs through a generated launcher script in the run dir, so you can
always see exactly what was executed and re-run it by hand.

## Windows host, WSL agents

Looper spawns `wsl.exe -d <distro> -- bash -lic "source /mnt/c/…/run.sh"`.
The login+interactive shell is what makes an nvm-installed `claude` resolve;
override per task with `target.shell` (e.g. `zsh -lc`). The run directory is
reached from WSL through `/mnt/c` (`wslMountPrefix` in settings), which is also
how the `done` / `idle` signal files cross the boundary — no networking.

## Task definition

See `examples/task.example.json`. Fields:

| field | notes |
|---|---|
| `schedule` | `{"every": "5m"}` or `{"cron": "*/10 * * * *"}` |
| `target` | `{"kind": "wsl", "distro": "Ubuntu", "shell": "bash -lic"}` or `{"kind": "windows"}` |
| `cwd` | as the target sees it (`/home/…` or `C:\…`) |
| `check.command` | shell command; `timeoutSec` default 60 |
| `classifier` | optional; `model`, `prompt`, `timeoutSec`, `maxBudgetUsd` |
| `agent.model` | any `--model` value; blank = claude default |
| `agent.mode` | `interactive` (default) or `headless` |
| `agent.permissionMode` | passed as `--permission-mode`; default `auto`, blank omits it |
| `agent.extraArgs` | appended verbatim to the `claude` command line |
| `agent.maxRuntimeMin` / `idleGraceMin` / `onIdleTimeout` | run limits (see above) |
| `backoff.maxConsecutiveErrors` | auto-pause the task after N failed cycles in a row |

Prompt templates get `{{summary}}`, `{{context}}`, `{{task}}`, `{{taskId}}`,
`{{runId}}`, `{{trigger}}`.

## Resilience

- Each task cycle is isolated: a throwing step is recorded and the task goes
  back to idle; N consecutive errors auto-pause it with a visible reason.
- Every child process has a timeout and is tree-killed (`taskkill /T` on
  Windows; on the Linux side leftovers are found by the `LOOPER_RUN` marker in
  `/proc/*/environ` and killed).
- Uncaught exceptions in the main process are logged, not fatal. A renderer
  crash reloads the UI; the engine (main process) is unaffected.
- Runtime state is persisted after every transition; on restart, runs that
  were in flight are logged as `interrupted`.
- Single-instance lock.

## Known limitations / next

- Closing the window quits Looper (and stops running agents). Tray mode and
  a standalone daemon are the obvious next step; the engine has no Electron
  dependency so this is a packaging change.
- Interactive claude shows a "trust this folder?" dialog on first use of a
  directory; Looper answers it (`autoTrustWorkspace`, default on).
- Any other interactive prompt (permission request, question) is detected on a
  headless terminal model of the session (its "Esc to cancel" footer is
  visible on screen) and starts the idle clock: after `idleGraceMin` the run
  ends, or is held for you if `onIdleTimeout: "hold"`. In testing,
  `--permission-mode auto` still prompted before creating a file, so for fully
  unattended tasks use `acceptEdits` / `--allowedTools …` in `extraArgs`, or
  set `hold` and answer prompts in the terminal tab.
- The Windows-native (`powershell`) target and the WSL-host → Windows-target
  path are implemented but untested so far; the WSL/Linux target is tested
  end to end (headless and interactive, including the `looper-done` signal).
- Run directories are never pruned automatically yet (`RunStore.prune` exists).
