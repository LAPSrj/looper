# Looper

**A manager for agentic loops.** Schedule AI agents like cron jobs, watch them
work in real terminals, and stop burning tokens on idle polling.

An agent that polls for its own work wastes tokens and context on every empty
check — and its conversation eventually fills up and gets compacted. Looper
inverts the loop: a cheap check script (and optionally a small classifier
model) decides whether there is work, and only then a fresh agent session is
started. No idle burn, no context rot, at most one agent per task, ever.

- **Cron-style scheduling** — wall-clock slots, timezones, active-hours
  windows and weekday constraints; or fully manual tasks you fire on demand.
- **Easy task setup** — an editor with Schedule / Check / Classifier / Agent
  tabs, templates, import/export; agents and scripts can register tasks by
  dropping a JSON file in the inbox.
- **Monitoring built in** — per-task run log with results and reports, live
  status, and a real terminal tab you can watch *and type into* mid-run.
- **Token savings by design** — a shell check and an optional haiku-class
  classifier gate every run, so the expensive model only starts when there is
  real work to do.
- **Fresh session every run** — no context accumulation; the agent signals
  `looper-done`, files its report, and the loop resumes.
- **Any harness, any environment** — Claude Code, Codex, or a custom agent
  CLI. The main setup is Looper on Windows driving agents inside WSL; it also
  runs on Linux/WSL directly and can drive native PowerShell agents.

## How a task runs

```
IDLE ──schedule──▶ CHECKING ──act:false──▶ IDLE
CHECKING ──act:true──▶ [CLASSIFYING ──no──▶ IDLE] ──yes──▶ RUNNING ──done──▶ IDLE
```

The check and the classifier are both optional — each has a checkbox in the
task editor that keeps its configuration while off. Without a check, every
slot goes straight to the classifier/agent.

1. **Check** (optional) — your script runs in the task's directory. The last line of its
   stdout must be JSON: `{"act": true, "summary": "3 new issues", "context": {…}}`.
   Non-zero exit, timeout or non-JSON output is an **error**, never a trigger.
2. **Classify** (optional) — `claude -p --model haiku` gets the summary/context
   and answers `{act, reason}` under a strict schema and a dollar budget.
3. **Agent** — the task's harness (Claude Code, Codex, or any custom agent
   CLI) starts in the task's directory with your prompt (the check output is
   templated in via `{{summary}}` / `{{context}}`, or appended if you don't
   reference them). Interactive by default, in a real pty shown in Looper's
   terminal tab. The run ends on the first of:
   - the agent runs `looper-done <status> "<headline>"` and then writes its
     final message (its instructions say to). The status is `success`
     (everything fully done), `warning` (fully done, but read the report) or
     `error` (couldn't complete — counts toward auto-pause); omitted means
     success. The headline is the run's result, the message its detailed
     report; a `Stop` hook Looper injects delivers the message when the turn
     ends and the session is closed,
   - Claude Code only: it sits idle after a turn longer than `idleGraceMin`
     without signalling (the same `Stop` hook reports idleness) — ends
     the run, or holds it for a human if `onIdleTimeout: "hold"`,
   - the agent process exits, or
   - `maxRuntimeMin` is exceeded.

   `mode: "headless"` runs without a terminal (`claude -p` / `codex exec`):
   process exit is the signal, nothing to type into. The final response is the
   report; `looper-done` still names the headline (else the response's first
   line does).

## Environments & harnesses

**Settings → Environments** defines where things run and what runs there:

- An **environment** is either the local shell or a bridge to another world:
  - `local` — the native shell of whatever machine Looper runs on (bash/zsh
    on Linux/macOS/WSL, PowerShell on Windows). The only kind most users need.
  - `wsl` — a WSL distro, reachable from a Windows host through `wsl.exe`.
  - `windows` — native PowerShell, reachable from inside WSL through interop.

  A bridge owns everything about its crossing, including how it sees the
  host's files (the Windows-drive mount prefix, default `/mnt`, is a
  per-environment advanced field). The environment editor only offers the
  kinds your host can actually reach.
- Each environment holds one or more **harnesses**: agent CLIs installed
  there. `claude-code` gets full integration (model / permission-mode flags,
  injected system prompt, idle detection, per-harness workspace-trust
  auto-answer). `codex` and `custom` are invoked as `command [args…]
  "<prompt>"` with the instruction footer prepended to the prompt;
  `looper-done` is on PATH for all of them. A harness can also carry its own
  environment variables — handy for two installs of the same tool on
  different accounts or config dirs — and a preset list of models (Models
  tab) that fills the task editor's Model dropdown; by default it holds the
  unprefixed main models of the CLI (`fable`, `opus`, `sonnet`, `haiku` for
  Claude Code, the `gpt-…` line for Codex).

A task picks an environment (General tab) and one of its harnesses (Agent
tab). The optional classifier always runs Claude Code: the task's harness if
it is one, otherwise the environment's first `claude-code` harness.

First run creates a "This machine" environment, plus the reachable bridge
(WSL on a Windows host, Windows inside WSL).

Every run is a fresh session — no context accumulation, no compaction. Put
anything the agent must remember between runs in the project's `CLAUDE.md`.

Both environments and harnesses can cap how many tasks run in them at once
("Limit concurrent tasks" in their editors; off by default). A due task over
the cap simply waits its turn and starts as soon as a slot frees up.

Schedules are cron expressions and keep wall-clock slots, evaluated in the
task's timezone (default: the computer's); a slot that passes while a cycle is
busy is logged as skipped, never overlapped. The schedule itself can also be
turned off (Schedule tab): a **manual task** never fires on its own and runs
only via Run Now (F5, toolbar, context menu) or the CLI/inbox `run` command.

## Install / run

No compiler toolchain needed on any platform: node-pty ships N-API prebuilds
(win32/linux/mac), which work in both Node and Electron as-is.

```bash
npm install
npm run dev            # Electron app with hot reload
npm run build:all      # out/ (app) + dist/cli.js + dist/terminal-worker.js
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
settings.json          # environments (each with its harnesses), defaultEnvironmentId, timings
tasks.json
state.json             # runtime snapshot (for the CLI and crash recovery)
engine.log             # engine diagnostics (Advanced ▸ Engine Log); entries older
                       # than Settings → Engine log retention (default 10 days)
                       # are pruned automatically
inbox/                 # + processed/ rejected/
tasks/<id>/runs.jsonl  # one record per phase per run; records and run folders
                       # older than Settings → Run log retention (default 30
                       # days) are pruned automatically
tasks/<id>/runs/<runId>/
  check.sh|ps1  check.out.txt  check.err.txt
  classify.sh   classify-prompt.txt  classify.out.txt
  run.sh|ps1    prompt.txt  system.txt  settings.json
  output.log    # raw terminal capture of the agent session
  done  stop.json    # signal files: looper-done status + headline, last Stop hook payload
  bin/looper-done
```

Every step runs through a generated launcher script in the run dir, so you can
always see exactly what was executed and re-run it by hand.

## Windows host, WSL agents

Looper spawns `wsl.exe -d <distro> -- bash -lic "source /mnt/c/…/run.sh"`.
The environment's Shell setting picks the flags. "Same as your terminal"
(`bash -lic`, the default) reads `~/.bashrc` too, so tools whose installers only
edit that file (nvm, bun) resolve without changes; bash's two job-control
warnings, unavoidable without a terminal, are dropped from the captured output.
"Basic shell, without your terminal setup" (`bash -lc`) reads just `~/.profile`
and prints no warnings, but anything the harness or a check command needs must
be on the PATH it sets.
"Custom" takes any shell and flags (e.g. `zsh -lc`).
Headless runs read the harness through plain pipes; only interactive runs get a
pseudo-terminal. The run directory is
reached from WSL through `/mnt/c` (the environment's mount prefix), which is also
how the `done` / `stop.json` signal files cross the boundary — no networking.

## Task definition

See `examples/task.example.json`. Fields:

| field | notes |
|---|---|
| `schedule` | `{"cron": "*/10 * * * *"}`; optional `timezone` (IANA name, e.g. `"Europe/Lisbon"`) the slots are evaluated in — unset means the computer's; `"enabled": false` makes the task manual (schedule kept, never fires) |
| `environmentId` | id of an environment from Settings (e.g. `"local"`) |
| `cwd` | as the environment sees it (`/home/…` or `C:\…`) |
| `env` | extra environment variables for every step of the task; override the harness's |
| `check` | optional; `command` (shell), `timeoutSec` default 60; absent = the agent runs every slot; `"enabled": false` keeps the config but skips the step |
| `classifier` | optional; `model`, `prompt`, `timeoutSec`, and the same `enabled` switch |
| `agent.harnessId` | harness from the environment; blank = its first one |
| `agent.model` | Claude Code / Codex: passed as `--model`; blank = the CLI's default. The editor offers the harness's preset models plus a custom value |
| `agent.mode` | `interactive` (default) or `headless` |
| `agent.permissionMode` | Claude Code only: passed as `--permission-mode`; default `auto`, blank omits it |
| `agent.extraArgs` | appended verbatim to the harness command line |
| `agent.maxRuntimeMin` / `idleGraceMin` / `onIdleTimeout` | run limits (see above) |
| `backoff.maxConsecutiveErrors` | auto-pause the task after N failed cycles in a row |
| `note` | one-off guidance (`{"text": "…", "runsLeft": 1}`) appended to the agent prompt, set from the Task menu, toolbar or context menu; each run whose agent received it uses up one charge, but a run that ends as an engine error (spawn failure, usage limit) does not |

Prompt templates get `{{summary}}`, `{{context}}`, `{{task}}`, `{{taskId}}`,
`{{runId}}`, `{{trigger}}`.

## Resilience

- Each task cycle is isolated: a throwing step is recorded and the task goes
  back to idle; N consecutive errors auto-pause it with a visible reason.
- Every child process has a timeout and is tree-killed (`taskkill /T` on
  Windows; on the Linux side leftovers are found by the `LOOPER_RUN` marker in
  `/proc/*/environ` and killed).
- A Claude Code usage-limit hit — the rejected `rate_limit_event` in headless
  runs, the "hit your … limit · resets …" banner on the interactive screen —
  ends the run as an error that retries at the advertised reset time; it
  neither counts toward auto-pause nor consumes a one-off note.
- Uncaught exceptions in the main process are logged, not fatal. A renderer
  crash reloads the UI; the engine (main process) is unaffected.
- Runtime state is persisted after every transition; on restart, runs that
  were in flight are logged as `interrupted`.
- Single-instance lock.

## Known limitations / next

- Closing the window quits Looper (and stops running agents) unless "Close to
  system tray" is on in Settings. `looper --hidden` starts straight into the
  tray, and Settings → "Start with the computer" registers exactly that as a
  login item. A standalone daemon is still open; the engine has no Electron
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
- The Windows-native (`powershell`) environment and the WSL-host →
  Windows-environment path are implemented but untested so far; the WSL/Linux
  environment is tested end to end (headless and interactive, including the
  `looper-done` signal).
- `codex` / `custom` harnesses have no idle detection and no detailed report
  in interactive mode (the `Stop` hook and the prompt-on-screen check are
  Claude Code specific): interactive runs end only via `looper-done` (headline
  only), process exit or `maxRuntimeMin`. The `codex exec`
  headless form has not been tested against a real Codex install yet.
- Remote environments (SSH) would need launcher/signal transport beyond the
  shared filesystem the WSL↔Windows pair relies on; not implemented.
