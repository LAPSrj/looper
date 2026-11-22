# CLI and automation

Looper ships a `looper` command-line tool. It does not run tasks itself — it
sends its commands to the Looper running on the data directory (the desktop
app or `looper serve`), starting it first when none is running, or reads the
app's data files directly for read-only commands like `list` and `logs`.

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
| `looper agents` | print the task-authoring guide for agents: what to read, then how to validate and register |
| `looper environments` | print the configured environment and harness ids — what a task's `environmentId`/`harnessId` must name |
| `looper schema` | print the task JSON field reference as JSON, generated from the schema: every field with its type, default, and allowed values, the per-kind permission modes, and the configured environments/harnesses when the data dir's `settings.json` is readable |
| `looper add <file> [--update] [--fix] [--template <id>] [--timeout <s>]` | validate a task JSON (or `.loopertask`) file (`-` reads it from stdin), send it to Looper, and wait until Looper has stored it (see [adding a task](#adding-a-task)); `--update` changes the existing task with that id instead of creating one; `--fix` first replaces invalid values with defaults, using the `.loopertask` import heuristics; `--template` starts from a template, whose fields the file's replace |
| `looper export <taskId> [--out <path>]` | print a stored task as a `.loopertask` document (the same file as **File → Export Task…**), or write it to `--out` (a file, or a directory to write `<id>.loopertask` into) |
| `looper validate <file> [--out <dir>]` | validate a task JSON and write the `.loopertask` document next to it (or into `--out <dir>`) |
| `looper migrate <file...>` | rewrite one or more Looper files (`.loopertask`/`.loopertpl`, `tasks.json`/`templates.json`, or a bare task JSON) from an older format version to the current one |
| `looper list [--json]` | list every task with its current state, next run time, and last result |
| `looper run <taskId> [--reason <r>] [--event <line>] [--wait] [--skip-check] [--skip-classifier] [--timeout <s>]` | start a run now, or with `--event` hand the task one trigger event, and print what Looper did. With `--wait` or a `--skip` option it prints the run's id instead; `--wait` then waits for the run to end, prints its result and report, and exits 1 when it ended with an error, a warning, a stop, a time limit or held |
| `looper pause <taskId> [--reason <r>] [--timeout <s>]` | pause the task |
| `looper resume <taskId> [--timeout <s>]` | resume a paused task |
| `looper stop <taskId> [--reason <r>] [--timeout <s>]` | stop the task's current run |
| `looper remove <taskId> [--timeout <s>]` | move the task to the Recycle Bin |
| `looper enable <taskId> [--timeout <s>]` | enable the task |
| `looper disable <taskId> [--timeout <s>]` | disable the task |
| `looper complete <taskId> [--reason <r>] [--timeout <s>]` | finish the task for good |
| `looper reopen <taskId> [--timeout <s>]` | undo a completion |
| `looper guide <taskId> <text...> [--run <runId>] [--timeout <s>]` | send guidance to the task's running agent (default: its newest run in flight); see [guidance for a run in progress](how-a-run-works.md#guidance-for-a-run-in-progress) |
| `looper chat <folder> [message...] [--message-file <file>] [--title <t>] [--model <m>] [--effort <e>] [--open] [--timeout <s>]` | start a chat in the folder (with its project's settings when a project has that folder) and send it the first message (`--message-file -` reads it from stdin); waits for Looper to start it and prints the chat's id |
| `looper end <id> [--reason <r>] [--timeout <s>]` | end a chat or terminal session (as **Close Conversation** does), a task run (as **Stop Run…** does), or the run in progress of the task with that id; waits for Looper to do it and prints what it ended. Exits 1 when nothing has that id or the run has already ended, and 3 when Looper couldn't be started or didn't answer |
| `looper logs <taskId> [-n, --lines <n>] [--json]` | print the task's recent run records (default 30) |
| `looper done [message...]` | signal the end of the current agent run (needs `LOOPER_DONE_FILE`, set automatically in that run's environment) |
| `looper serve [--quiet] [--take-over]` | run the engine in this terminal, without the desktop UI |
| `looper status [--json]` | say whether a Looper app is running on the data directory (and which, with its version), and the CLI's version |
| `looper quit [--force] [--timeout <s>]` | quit the Looper running on the data directory as **File → Exit** does, and wait until it has (60 s by default); `--force` doesn't ask about runs in progress, which stop, as if you had confirmed it. Exits 3 when it hasn't quit in time, such as when a question waits in its window |
| `looper show <taskId> [--json]` | print a task's main settings and its state; `--json` prints the whole task and its state |
| `looper runs <taskId> [-n, --limit <n>] [--json]` | list the task's runs, newest first (default 30), with each one's result, length and detail |
| `looper report <runId> [--json]` | print how a run went and its agent's final report |
| `looper engine-log [-n, --lines <n>] [--follow]` | print the end of the app's engine log (default 50 lines); `--follow` keeps printing what the app adds |
| `looper sessions [--json]` | list the open chats, terminal sessions and task runs with their ids, kinds, status (and what each waits on), project and title |
| `looper send <ids> [message...] [--message-file <file>] [--file <path...>]` | send a message to one or more chats (queued while one works), terminal sessions (typed in), task runs (as guidance) or task builders, ids separated by commas; `--file` attaches files. Every id is checked before anything is sent |
| `looper interrupt <id>` | end the agent's turn in a chat or terminal session, and the whole run of a task run (**Stop**); a chat goes on with the next message, and its background subagents, workflows and commands keep running |
| `looper send-now <id>` | send a chat's queued messages, or a run's waiting guidance, at once, ending the agent's turn (**Send Now**) |
| `looper queue <id> [--cancel [messageId]] [--json]` | list a chat's queued messages or a run's waiting guidance; `--cancel` takes one back |
| `looper restart <id>` | start a chat's or terminal session's agent again on the same conversation (**Restart Agent**) |
| `looper rename <id> [name...]` | rename a chat or terminal session; no name gives it back its automatic one |
| `looper configure <chatId> [--model <m>] [--effort <e>] [--auto-compact on\|off\|default] [--permission-mode <mode>] [--harness <id>]` | change a chat's model, effort, auto compact (**Chat → Auto Compact**; `default` follows Settings → Chats), permission mode or harness (once the conversation has started, only a harness of its kind) |
| `looper compact <id>` | start a new chat from a compacted copy of a chat's or run's conversation: its messages, the latest session's tool calls and the results that fit, without thinking or errors (**Compact into New Chat**, **Continue Compacted**). A chat's new chat takes its place, keeping its name, settings and place in the list, and the old chat's id reaches the new one in every command; prints the new chat's id |
| `looper fork <chatId> --at <row>` | start a new chat from the conversation up to a row (**Fork from Here**); `looper transcript --json` lists the rows, counted from 0 |
| `looper auto-continue <chatId> on\|off` | turn **Continue When Limit Resets** on or off for a chat |
| `looper mute <chatId> on\|off` | turn **Mute Notifications** on or off for a chat: while it's on, no paired device gets a push when the chat finishes its turn or asks for permission |
| `looper continue-anyway <chatId>` | let a chat continue even though the prompt-cache rule in Settings → Chats would stop it (**Continue Anyway**) |
| `looper watch <chatId> <taskId> [--event <id>] [--stop]` | send the chat's agent the task's run ends and trigger events (**Watch Task Events**); `--event` keeps it to the events related to that id, `--stop` stops it |
| `looper transcript <id> [--agent <agentId>] [--raw] [--no-thinking] [--no-tools] [--plain] [--json]` | print a chat's, run's or task builder's conversation as Markdown (**Save as Markdown**); `--agent` prints a subagent's, `--raw` every record of the transcript |
| `looper activity <id> [--json]` | list a chat's, terminal session's or run's background commands, subagents and workflows |
| `looper close-all [--project <id>]` | close every chat and terminal session, or only a project's (**Close All Conversations**) |
| `looper continue <runId> <guidance...>` | start a run that resumes a finished run's conversation with the guidance as its whole prompt |
| `looper recent [-n, --limit <n>] [--since <time>] [--skipped] [--json]` | list the newest runs across every task (default 30), and with `--since` (`2h`, `30min`, `1d` or a date) every run since then |
| `looper output <runId> [--raw]` | print the end of a run's agent output |
| `looper note <taskId> [text...] [--runs <n>]` | set the guidance the task's next run (or next `n` runs) gets (**Add Guidance for Next Run**); no text clears it |
| `looper attention [--json]`, `looper attention clear [taskId]` | list what **Needs Attention**, or clear it all or one task's |
| `looper clear-runs <taskId>` | delete the task's run history |
| `looper versions <taskId> [--json]`, `looper version <taskId> <n> [--diff]`, `looper rollback <taskId> <n>` | list a task's versions, print one (or with `--diff` what changed since), or put one back (**Version History**) |
| `looper folders [--json]`, `looper folders add <name> [--parent <folder>]`, `looper folders rename <folder> <name...>`, `looper folders remove <folder>` | list, add, rename or delete the Tasks tab's folders; a folder is named by its id or its name |
| `looper move <taskId> [--folder <folder>]` | move a task to a folder, or to the top level without `--folder` |
| `looper bin [--json]`, `looper bin restore <taskId>`, `looper bin purge <taskId>`, `looper bin empty` | list the **Recycle Bin**, put a task back, or delete one or all of them for good |
| `looper path <id> [--run-dir]` | print the working directory of a task, project, run, chat or terminal session; `--run-dir` prints the run's own folder in the data directory |
| `looper build start <description...> --task <id> \| --project <id>` | start the task builder (**Edit with Agent** for `--task`, using the builder already open on the task if there is one; **New Task with Agent** in the project's folder, environment and agent settings for `--project`), send it the description and print its id. It starts in the chat view, so `looper send` can answer it. The desktop app also opens its window; under `looper serve` it runs without one |
| `looper build draft <id> [--json]` | print whether the builder's agent is working, whether its work is saved, what keeps its draft from being saved, and the draft task |
| `looper build save <id>` | store the draft as the task (**Save**) and print the task's id |
| `looper build close <id> [--discard]` | stop the builder and delete its files, closing its window on the desktop; refused while its work isn't saved, unless `--discard` drops it and puts back the files it changed (**Don't Save**) |
| `looper templates [--json]`, `looper templates show <id>`, `looper templates import <file>`, `looper templates remove <id>` | list, print, add (from JSON or a `.loopertpl`, `-` reads stdin) or delete templates. An import refuses an id another template has |
| `looper projects [--json]`, `looper projects remove <id>`, `looper projects move <id> [--folder <folder>]` | list the projects, delete one (its folder and files stay), or move one to a project folder |
| `looper project-folders [--json]`, `looper project-folders add\|rename\|remove …` | list, add, rename or delete the Projects tab's folders, as `looper folders` does for tasks |
| `looper models <harnessId> [--env <id>] [--json]` | list the models a harness offers |
| `looper settings [key]` | print the settings as JSON, or one of them by its dotted key, such as `chats.confirmClose` |
| `looper logins [--json]`, `looper login <harnessId> [--env <id>]` | list the Claude Code logins the harnesses use, or open **Log In** for one on the desktop |
| `looper history [--search <text>] [--project <id>] [-n, --limit <n>] [--json]` | list the newest conversations, Looper's and Claude Code's and Codex's from outside it (**History**) |
| `looper history --runs [--task <id>] [--result <result>] [--project <id>] [--hide-skipped] [--hide-no-action] [--search <text>] [-n, --limit <n>] [--json]` | list the newest task runs instead, with a result column (**Task History**); `--task` and `--result` (such as `success`, `error`, `noop`, `skipped`) imply `--runs`, and the two `--hide` options are View → Task Runs' Show Skipped Runs and Show Runs with No Action turned off |
| `looper history show <id> [--agent <agentId>] [--no-thinking] [--no-tools] [--plain] [--json]`, `looper history continue <id> [--compact] [--terminal]` | print a conversation from the history, or continue it in a chat (**Continue in Chat**, **Continue Compacted**) or a terminal session |
| `looper open <id>` | show a chat, terminal session, task or run on the desktop |
| `looper remote [--json]`, `looper remote stop <id>`, `looper remote restart <id>` | list the **Remote Control** conversations, end one, or continue one in a new session |
| `looper rest [on\|off]` | turn **Rest Mode** on or off, or print its state |
| `looper prevent-sleep [30\|60\|120\|until-off\|off]` | keep the computer awake for that many minutes or until turned off, turn it off, or print its state (**Prevent Sleep**) |
| `looper addons [--json]`, `looper addons install <file>`, `looper addons enable\|disable\|restart\|remove <id>` | list the addons, install a `.looperaddon` (the desktop asks first, as for a double-click), or turn one on or off, restart it or remove it |
| `looper devices [--json]`, `looper devices rename <id> <name...>`, `looper devices remove <id>`, `looper devices notify <id> [--turns on\|off] [--questions on\|off] [--runs on\|off] [--warnings on\|off]`, `looper devices pair` | list the devices paired with **Remote Access**, rename one, unpair one, choose what one is notified of (chat turn ends, questions and permission requests, task runs, login and usage warnings; with no option it prints them), or print a code to pair a new one |
| `looper environments add <file>`, `looper environments edit <id> <file>`, `looper environments remove <id>` | add an environment from a JSON file of its fields (`-` reads stdin), change one (the file's fields replace its own), or remove one (not the last) |
| `looper harnesses add <environmentId> <file>`, `looper harnesses edit <environmentId> <id> <file>`, `looper harnesses remove <environmentId> <id>` | the same for an environment's harnesses |
| `looper projects add <folder> [--name] [--env] [--harness] [--model] [--effort] [--permission-mode] [--mode]`, `looper projects edit <id> [--folder <folder>] [the same options]` | add a project (the folder as its environment sees it) or change one |
| `looper allow <id>`, `looper deny <id>` | allow or deny the tool call a chat's or run's agent waits on (the oldest, when there are several) |
| `looper terminal <id> [--run <runId>] [--system]`, `looper command <projectId> <argv...> [--system]` | open a task's or project's harness in a Looper terminal session (or the system's terminal), or run a program in a project's environment and folder in one |
| `looper settings-set <key> <json>`, `looper store-move <tasks\|templates> <file>` | change one setting by its dotted key (the value is JSON), or move the tasks or templates file |

### Adding a task

`looper add` reads the task from a file, or from stdin when the file is `-`,
so a script or an agent can pass the JSON inline:

```bash
looper add - <<'EOF'
{ "name": "Check the cert renewed", "environmentId": "env-1", … }
EOF
```

It creates a task, and refuses an id that already exists, so a new
task never replaces one by accident. `looper add --update` changes an
existing task, and refuses an id that doesn't exist yet. `add` sends the
task to Looper and waits (30s by default, `--timeout <s>`) for it to store
the task, then prints the result:

| exit | output | meaning |
|---|---|---|
| 0 | `added task <id>` / `updated task <id>` | the app stored it |
| 1 | `invalid task:` and the errors, `task <id> already exists…`, `no task <id> to update…`, or `rejected task <id>: <reason>` | nothing was stored |
| 2 | `cannot read …` | unreadable input or settings |
| 3 | `… didn't start within …s` or `… didn't answer …` | Looper couldn't be started or didn't answer in time; nothing was stored |

### Commands that change a task

`run`, `pause`, `resume`, `stop`, `remove`, `enable`, `disable`, `complete`,
`reopen`, and `guide` send their command to Looper and print what it did,
such as `Paused "Nightly backup".` The `--reason <r>` text becomes the
pause/stop reason shown in the task's state, or the completion reason kept on
the task. `looper done` is meant
to run inside an agent session started by Looper — it is the same signal an
agent gives by running `looper-done` there. An agent whose task allows it
finishes the task for good with `looper-complete "<why>"` instead, which is
only on its PATH when the task's **Allow this task to be marked completed**
option is on. Likewise, `looper-ask "<question>"` is only on its PATH when
the task lets the agent ask you a question (see [questions from the
agent](how-a-run-works.md#questions-from-the-agent)); `guide` answers a
question the agent is waiting on.

`looper list`, `looper logs`, `looper show`, `looper runs`, `looper report`,
`looper status` and `looper engine-log` read `tasks.json`, `state.json`,
`tasks/<id>/runs.jsonl` and `engine.log` directly, so they work even if no app is currently
running — they just show whatever was last written to disk.

### Commands that wait for the app

`chat`, `end`, `add`, and every command in the table from `sessions` on ask
the running app and wait for its answer (30 s by default, `--timeout <s>`).
They print what the app answered, and their errors go to stderr. They exit
with 0 when the app did it, 1 when the app refused (the reason says why, such
as an id nothing has), 2 for a wrong option, and 3 when Looper couldn't be
started or didn't answer in time; a command that gets 3 never runs later.
`open`, `login`, `addons` and
`devices` need the desktop app: `looper serve` has no windows, addons or
paired devices, and says so.

### What the command-line tool may do

**Settings → Advanced → Command-line tool** decides which commands work,
for you and for the agents Looper starts, which have `looper` on their
PATH. The app refuses a command above the level, so an agent that calls
Looper's command server itself gets no further. The help leaves those commands out,
and running one says which level it needs.

| level | adds |
|---|---|
| Basic | what Looper itself relies on: `add`, `validate`, `export`, `migrate`, `list`, `logs`, `run`, `pause`, `resume`, `stop`, `remove`, `enable`, `disable`, `complete`, `reopen`, `guide`, `chat`, `end`, `done`, `serve` and the commands that print help (`home`, `example`, `agents`, `environments`, `schema`) |
| Standard (the default) | every other command in the table above, except the ones the next two levels add |
| Extended | `environments add\|edit\|remove`, `harnesses add\|edit\|remove`, `projects add\|edit`, `addons enable` and `devices pair`: what decides where and with what every agent runs |
| Unrestricted | `allow`, `deny`, `terminal`, `command`, `settings-set`, `store-move`, `configure --permission-mode` and `--harness`, and `history continue --terminal`: with these an agent can answer its own permission requests, start an agent with more permissions than its own, or run any program outside its harness's checks |

## File versions

`.loopertask`/`.loopertpl` documents carry a `$version`; `tasks.json` and
`templates.json` carry a `version`. Both are the same integer — the
definition-format version, currently 3. Version 3 added a task's project
(`projectId`, `overrideEnvironment`, `overrideAgent`); a task without a
project is filed under the [project](projects.md) of its `cwd` when it's
stored, so a version 2 task needs no change. A newer Looper migrates an older
file's `$version`/`version` up automatically the moment it reads it (`looper
add`, `looper validate`, and the app itself all do this transparently); an
older Looper refuses a file written by a newer one, with a message naming
the version to update to. `looper migrate <file...>` rewrites one or more
files to the current version in place, for anyone who wants the file itself
brought current rather than migrated silently on every read.

## How the CLI talks to Looper

Every command that changes something, and every command that waits for an
answer, goes to a small server the running Looper (the desktop app or
`looper serve`) keeps on `127.0.0.1`. Its port and a random token are in
the data directory's `engine.lock`, which only your user can read, and
each command carries the token, so no other program on the computer can
command Looper. A command is one request and one answer: it either happens
now, or fails with the reason, and nothing waits to run later.

### Starting Looper

When no Looper is running on the data directory, a command starts it, waits
for it within its `--timeout`, and then sends the command. It says so on
stderr (`Looper isn't running on <dir>; starting Looper…`).

- On Windows, and from WSL when the data directory is on a Windows drive, it
  starts the desktop app the way the app last recorded in `cli/app.json`.
  The app records it each time it starts, so open Looper once after
  installing it.
- On macOS, it opens the app with `open`, when Looper last ran from the
  Applications folder. Where that fails, such as over SSH with no one logged
  in to the Mac, it starts `looper serve` instead.
- On Linux, it starts the desktop app when there's a desktop (`DISPLAY` or
  `WAYLAND_DISPLAY` is set), and `looper serve` otherwise.

A `looper serve` started this way runs in the background and writes its
output to `serve.log` in the data directory. When Looper can't be started,
or doesn't answer in time, the command exits with 3.

## Using the CLI from WSL against Windows on the same machine

Looper's main setup is the desktop app on Windows driving agents inside WSL.
From WSL, point the CLI at the Windows data directory through the `/mnt/c`
mount:

```bash
export LOOPER_HOME=/mnt/c/Users/<you>/looper
looper list
looper add my-task.json
```

`LOOPER_HOME` (or `--data-dir`) is the only thing that needs to match. In
WSL's mirrored networking mode the CLI reaches the Windows app at
`127.0.0.1`. In the default NAT mode it reaches it at WSL's default gateway,
which is Windows' address on its WSL network adapter: the app listens there
too, and only there besides `127.0.0.1`, so other computers can't reach it.

## Registering tasks programmatically

Agents and scripts register or update tasks the way you do, with
`looper add` (see [adding a task](#adding-a-task)); `-` reads the task
from stdin, so nothing has to be written to a file first. The task's `id`
can be left out, and `name` is then slugified into one.

A task naming an environment or harness this setup doesn't have is an error
wherever the task is actually stored — `looper add` and the editor both
reject it. Only `looper validate` reports those references as
warnings, since the file may be written for another Looper setup whose ids
differ; everything else it finds is still an error. When the target data
dir's `settings.json` is readable, `looper add` checks the references
itself instead of bouncing off the engine.

## The example workflow

```bash
looper example > task.json          # a filled-in example task definition
looper example --script > check.sh  # a matching example check script
looper validate task.json           # check it and get issues-triage.loopertask next to it
looper add task.json                # validate it and wait for the app to store it
```

`looper example` prints the same shape as
[`examples/task.example.json`](examples/task.example.json) in the repo.
For what each field means, see the [task editor](tasks.md) — the CLI and the
in-app editor produce and accept the same task JSON.

## `looper serve`

`looper serve` runs the full scheduling engine — check, classifier, agent
runs, retention sweeps, the CLI's commands — in the current terminal, with no
Electron window. Use it on a headless machine, or anywhere you don't want
the desktop app running.

What it does the same as the app:

- Runs every task on its schedule, including interactive-mode agents (they
  still get a real pty; you just don't get a run window to follow them in
  — use `--quiet` to suppress the raw agent output that's echoed to
  stdout by default, or read `output.log` in the run directory).
- Answers the CLI's commands, and prunes old run logs and the engine log on
  the same schedule as the app.
- Writes `engine.log`, `tasks/<id>/runs.jsonl`, and per-run directories
  exactly as the app would.

Only one Looper runs on a data directory at a time, since two would run
every task twice. The running one (the desktop app or `looper serve`) keeps
`engine.lock` there and refreshes it every 5 seconds. Starting a second one
asks whether to take over: the desktop app with a dialog, and `looper serve`
with a y/N prompt (or `--take-over` when there's no terminal to ask in).
Taking over stops the other one, along with any runs it has going, and the
new one starts about 7 seconds later. A lock that wasn't refreshed for 20
seconds, or whose process is gone, belongs to a Looper that crashed, so the
next one starts without asking.

What it doesn't do: there's no run window, no system notifications, no
tray icon, and no settings/task editor UI — manage tasks with the CLI, or by
editing `tasks.json` while it's stopped. Stop it with Ctrl-C;
it shuts the engine down cleanly before exiting.

## The data directory

Looper keeps all its state in `~/looper` (your home directory, every
platform) — override with the `LOOPER_HOME` environment variable, or
`--data-dir` for a single CLI invocation. `looper home` prints the directory
in use, and **Advanced → Open Data Directory** opens it from the app.
**Settings → Advanced → Tasks file / Templates file** can keep `tasks.json`
and `templates.json` somewhere else.

```
settings.json         environments (each with its harnesses), default
                       environment, timing settings
tasks.json             every task definition, and the deleted tasks in the
                       Recycle Bin
projects.json          the projects, in the Projects tab's order
state.json             runtime snapshot: current state, next run time, last
                       result — what `looper list` reads — and the Chats
                       window's open chats and terminal sessions, which
                       Looper opens again when it starts
windows.json           where each kind of window was last: its size,
                       position and maximized state
engine.lock            the running Looper's heartbeat (one Looper per data
                       dir), and the port and token the CLI reaches it with
cli/                   the command-line tool every session's `looper` runs,
                       and app.json: how the CLI starts the desktop app
serve.log              the output of a `looper serve` the CLI started
engine.log             diagnostics; entries older than Settings -> Engine
                       log retention (default 10 days) are pruned
addons/<id>.looperaddon  the installed addons' manifests (see addons.md)
remote-access/         Remote Access: devices.json (the paired devices),
                       push.json (notification keys and subscriptions), the
                       Tailscale's folder (tailscale/, with the computer's
                       sign-in), and uploads/ (files sent from a device)
tasks/<id>/runs.jsonl  one record per phase (check/classify/agent) per run;
                       records and run folders older than Settings -> Run
                       log retention (default 30 days) are pruned
tasks/<id>/versions.jsonl  the task's version history, one version per line
tasks/<id>/versions/blobs/ the file contents those versions recorded, one
                       file per content (named by its SHA-1)
builder/<id>/          an open New or Edit Task with Agent window's draft,
                       helpers and tests; deleted when the window closes
tasks/<id>/runs/<runId>/
  check.sh (or .ps1)      the check step's launcher script
  check.out.txt, check.err.txt
  events.jsonl            watcher runs: the batch of trigger events
                       (LOOPER_EVENTS_FILE)
  note.txt                runs with a one-off guidance note: its text
                       (LOOPER_NOTE_FILE)
  run.sh (or .ps1)        the agent's launcher script
  prompt.txt              the rendered agent prompt
  system.txt, settings.json  Claude Code only: injected instructions and
                       the hooks settings file
  output.log              raw capture of the agent session
  output.txt              rendered terminal (interactive) / stream lines (headless)
  done                    signal file: the looper-done status + headline
  complete                signal file: the looper-complete reason
  guidance.json           guidance sent to the running agent, until it
                       picks it up
  notice.json             Looper's context-limit notice, until the agent
                       picks it up
  codex-session.json      Codex only: the thread id of the run's conversation
  stop.json               signal file: the last Stop-hook payload
  stop-reminded           marker: the one-time looper-done reminder was issued
  session.json            the SessionStart-hook payload (names the transcript)
  bin/looper-done         the helper script the agent's PATH exposes
  bin/looper-restart      tasks with a context limit: the restart helper
  bin/looper-ask          tasks that let the agent ask: the question helper
                       (looper-ask.cmd and looper-ask-request.ps1 on Windows)
  ask/                    the questions looper-ask sends (requests/) and
                       Looper's answers to them (responses/)
  bin/looper-stop-hook    the Stop-hook gate script (.ps1 on Windows)
  bin/looper-subagent-guard  the PreToolUse hook that keeps subagents from
                       running the helpers (.ps1 on Windows)
  session<N>-*            the files of agent session N, once a context
                       restart ended it (session1-session.json,
                       session1-done, session1-prompt.txt, …)
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
