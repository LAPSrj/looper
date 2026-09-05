# CLI and automation

Looper ships a `looper` command-line tool. It does not run tasks itself — it
talks to a running Looper app (the desktop app or `looper serve`) by dropping
JSON files into that app's **inbox** directory, or reads the app's data files
directly for read-only commands like `list` and `logs`.

## Getting the CLI on PATH

The CLI is not built by `npm run dev` or `npm run build`. Build it
separately, then link it:

```bash
npm run build:cli      # bundles src/cli into out/cli/cli.js
npm link                # puts `looper` on PATH (bin/looper.js -> out/cli/cli.js)
```

`npm run build:all` builds the app, the CLI, and the terminal worker together
— use it if you also want the desktop app current.

## Commands

Every command accepts a global `--data-dir <dir>` before the subcommand,
overriding the data directory Looper reads and writes (described at the
bottom of this page).

| command | what it does |
|---|---|
| `looper home` | print the data directory in use |
| `looper example [--script]` | print an example task JSON, or with `--script` an example check script |
| `looper add <file>` | validate a task JSON file and queue it in the inbox (registers or updates the task) |
| `looper list` | list every task with its current state, next run time, and last result |
| `looper run <taskId> [--reason <r>]` | queue a run-now command |
| `looper pause <taskId> [--reason <r>]` | queue a pause command |
| `looper resume <taskId> [--reason <r>]` | queue a resume command |
| `looper stop <taskId> [--reason <r>]` | queue a command to stop the task's current run |
| `looper remove <taskId> [--reason <r>]` | queue a command to remove the task |
| `looper enable <taskId> [--reason <r>]` | queue a command to enable the task |
| `looper disable <taskId> [--reason <r>]` | queue a command to disable the task |
| `looper logs <taskId> [-n, --lines <n>]` | print the task's recent run records (default 30) |
| `looper done [message...]` | signal completion from inside an agent run (needs `LOOPER_DONE_FILE`, set automatically in that run's environment) |
| `looper serve [--quiet]` | run the engine in this terminal, without the desktop UI |

`run`, `pause`, `resume`, `stop`, `remove`, `enable`, and `disable` don't act
directly: each writes a small command file into the inbox and prints its
path. The `--reason <r>` text becomes the pause/stop reason shown in the
task's state once the running app picks the file up. `looper done` is meant
to run inside an agent session started by Looper — it is the same signal an
agent gives by running `looper-done` there.

`looper list` and `looper logs` read `tasks.json`, `state.json`, and
`tasks/<id>/runs.jsonl` directly, so they work even if no app is currently
running — they just show whatever was last written to disk.

## How the CLI talks to a running app: the inbox

Commands that change something (`add`, `run`, `pause`, `resume`, `stop`,
`remove`, `enable`, `disable`) don't call the app directly. They write a
JSON file into `<data dir>/inbox/`, atomically (written to a `.tmp` file,
then renamed). A running Looper app — the desktop app or `looper serve` —
polls that folder, applies each file, and moves it into `inbox/processed/`
or `inbox/rejected/`.

This means the CLI works even when it's a different process, machine, or OS
than the app, as long as both see the same data directory. If nothing is
running, the files just sit in the inbox until something starts and picks
them up.

## Using the CLI from WSL against Windows on the same machine

Looper's main setup is the desktop app on Windows driving agents inside WSL.
From WSL, point the CLI at the Windows data directory through the `/mnt/c`
mount:

```bash
export LOOPER_HOME=/mnt/c/Users/<you>/looper
looper list
looper add my-task.json
```

`LOOPER_HOME` (or `--data-dir`) is the only thing that needs to match; the
Windows app keeps polling its inbox regardless of which side wrote to it.

## Registering tasks programmatically

Agents and scripts can register or update tasks the same way the CLI does:
write a task JSON file into `$LOOPER_HOME/inbox/`. Any dropped file that
does **not** have an `op` field is treated as a task definition and
registered or updated (matched by `id`, or `name` slugified into an `id` if
none is given).

Files that do have an `op` field are commands, not tasks. The accepted set
is exactly:

```json
{"op": "run", "taskId": "…"}
{"op": "pause", "taskId": "…", "reason": "…"}
{"op": "resume", "taskId": "…"}
{"op": "stop", "taskId": "…", "reason": "…"}
{"op": "remove", "taskId": "…"}
{"op": "enable", "taskId": "…"}
{"op": "disable", "taskId": "…"}
```

`reason` is optional and only meaningful for `pause` and `stop`.

Every file the inbox picks up — task or command — is moved out of `inbox/`
once handled, never left in place:

- **`inbox/processed/`** — succeeded, renamed with a timestamp prefix.
- **`inbox/rejected/`** — failed (invalid JSON, an unknown `op`, a task that
  fails validation, missing `taskId`, …), renamed the same way, with a
  matching `<file>.error.txt` next to it explaining why. Nothing is retried
  automatically — fix the file and drop a new one.

## The example workflow

```bash
looper example > task.json          # a filled-in example task definition
looper example --script > check.sh  # a matching example check script
looper add task.json                # validate and queue it
```

`looper example` prints the same shape as `examples/task.example.json` in
the repo.
For what each field means, see the [task editor](tasks.md) — the CLI and the
in-app editor produce and accept the same task JSON.

## `looper serve`

`looper serve` runs the full scheduling engine — check, classifier, agent
runs, retention sweeps, the inbox — in the current terminal, with no
Electron window. Use it on a headless machine, or anywhere you don't want
the desktop app running.

What it does the same as the app:

- Runs every task on its schedule, including interactive-mode agents (they
  still get a real pty; you just don't get a terminal tab to watch or type
  into — use `--quiet` to suppress the raw agent output that's echoed to
  stdout by default, or read `output.log` in the run directory).
- Applies inbox files, prunes old run logs and the engine log on the same
  schedule as the app.
- Writes `engine.log`, `tasks/<id>/runs.jsonl`, and per-run directories
  exactly as the app would.

What it doesn't do: there's no terminal tab, no system notifications, no
tray icon, and no settings/task editor UI — manage tasks with the CLI, the
inbox, or by editing `tasks.json` while it's stopped. Stop it with Ctrl-C;
it shuts the engine down cleanly before exiting.

## The data directory

Looper keeps all its state in `~/looper` (your home directory, every
platform) — override with the `LOOPER_HOME` environment variable, or
`--data-dir` for a single CLI invocation. `looper home` prints the directory
in use.

```
settings.json         environments (each with its harnesses), default
                       environment, timing settings
tasks.json             every task definition
state.json             runtime snapshot: current state, next run time, last
                       result — what `looper list` reads
engine.log             diagnostics; entries older than Settings -> Engine
                       log retention (default 10 days) are pruned
inbox/                 JSON drop folder for the CLI and scripts
inbox/processed/       handled files, timestamp-prefixed
inbox/rejected/        failed files, plus a matching .error.txt each
tasks/<id>/runs.jsonl  one record per phase (check/classify/agent) per run;
                       records and run folders older than Settings -> Run
                       log retention (default 30 days) are pruned
tasks/<id>/runs/<runId>/
  check.sh (or .ps1)      the check step's launcher script
  check.out.txt, check.err.txt
  run.sh (or .ps1)        the agent's launcher script
  prompt.txt              the rendered agent prompt
  system.txt, settings.json  Claude Code only: injected instructions and
                       the hooks settings file
  output.log              raw capture of the agent session
  output.txt              rendered terminal (interactive) / stream lines (headless)
  done                    signal file: the looper-done status + headline
  stop.json               signal file: the last Stop-hook payload
  stop-reminded           marker: the one-time looper-done reminder was issued
  session.json            the SessionStart-hook payload (names the transcript)
  bin/looper-done         the helper script the agent's PATH exposes
  bin/looper-stop-hook    the Stop-hook gate script (.ps1 on Windows)
  classify.sh (or .ps1)   the classifier's launcher script
  classify-*              the classifier session's own set of the same files
                       (classify-prompt.txt, classify-output.log/.txt,
                       classify-settings.json, classify-session.json,
                       classify-schema.json, classify-done, …) plus
                       bin/looper-classify — the verdict helper
```

Every step Looper runs — check, classifier, agent — goes through one of
these generated launcher scripts in the run directory, with the same
environment variables it actually got. You can always open a run's folder,
read exactly what was executed, and re-run any step by hand from a shell.

See [how a run works](how-a-run-works.md) for what happens during a run, and
[monitoring](monitoring.md) for viewing run history in the app.
