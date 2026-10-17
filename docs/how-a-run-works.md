# How a run works

Every task cycles through the same states, whether it fires on a schedule or
you trigger it by hand:

```
IDLE ──schedule──▶ CHECKING ──act:false──▶ IDLE
CHECKING ──act:true──▶ [CLASSIFYING ──no──▶ IDLE] ──yes──▶ RUNNING ──done──▶ IDLE
```

The task list shows these as **Idle**, **Checking**, **Classifying**,
**Running**, **Paused**, **Disabled**, and **Completed** (finished for good;
see [the task editor](tasks.md#general)). Check and classifier are both
optional (each has an enable switch in the [task editor](tasks.md)); without a
check, every due slot goes straight to the classifier or the agent.

## Checking

If the task has a check step, your script runs in the task's working
directory. The last non-empty line of its stdout must be a JSON object with a
boolean `act` field, e.g.:

```json
{"act": true, "summary": "3 new issues", "context": {"issues": [42, 57]}}
```

- `act: true` moves the cycle on (to the classifier, or straight to the
  agent). `summary` and `context` are optional and get passed along.
- `act: false` ends the cycle as **No action** — nothing else runs.
- A non-zero exit code, a timeout, or output whose last line isn't valid JSON
  with a boolean `act` is always an **error**, never a "nothing to do".
  Errors count toward auto-pause (see [troubleshooting](troubleshooting.md));
  a deliberate no-op never should be signaled as one.
- A failure caused by the computer being offline is recorded as a network
  error instead of an ordinary one — see
  [troubleshooting](troubleshooting.md#the-computer-was-offline-when-a-task-ran).
  A check WSL never started is recorded as an environment error — see
  [troubleshooting](troubleshooting.md#wsl-couldnt-start-a-step).

## Classifying

If a classifier is configured, it runs after a check that returned
`act: true` (or on every slot if there's no check). It's a Claude Code or
Codex session at the configured model (`haiku` by default) with the check's
`summary`/`context` folded into your prompt, under its own timeout — run the
same two ways as the agent. Headless (the default) is a `claude -p` or
`codex exec` call
that must answer `{"act": boolean, "reason": string}` under a strict schema.
Interactive runs in a real pty shown in the task's terminal tab — you can
watch it and type into it — and gives its verdict by running
`looper-classify act "<reason>"` or `looper-classify noop "<reason>"`,
followed by a short closing message. In both modes the classifier's output
streams to the terminal tab, its conversation shows in the run window
(replies typed as **Classifier**), and its files live under
`classify-*` in the run folder, fully separate from the agent's.

`act: false` ends the cycle as **No action** with the classifier's `reason`
as the detail; a malformed or failed response is an **error**, same as the
check. A failure caused by the computer being offline is recorded as a
network error instead — see
[troubleshooting](troubleshooting.md#the-computer-was-offline-when-a-task-ran) —
and one WSL never started as an environment error — see
[troubleshooting](troubleshooting.md#wsl-couldnt-start-a-step).

Skipping the classifier's fee on obvious no-ops is its whole purpose: it's a
cheap model call standing between a noisy check and an expensive agent
session.

## Starting the agent

Once check and classifier both said go, the task's harness (Claude Code,
Codex, or a custom CLI) starts a **fresh session** — no memory of earlier
runs, unless the Agent tab's Conversation is set to continue across runs
(see [the task editor](tasks.md#agent)) — in the task's working directory, interactive by default in a real pty
shown in the task's terminal tab (`mode: "headless"` runs without one, driven
by plain pipes).

The prompt is your template with `{{summary}}` / `{{context}}` (plus
`{{task}}`, `{{taskId}}`, `{{runId}}`, `{{trigger}}`) filled in, and any
`{{file:path}}` tags replaced with that file's contents. If your prompt
references none of `{{summary}}`/`{{context}}`/`{{events}}`, Looper appends
the check output under a `## Check output` heading (and a watcher run's
events under `## Trigger events`) so the agent still sees them. If the
task has a one-off guidance note (see below), it's appended
last, under a `## One-off guidance for this run` heading, so it overrides
anything conflicting earlier in the prompt.

Looper also tells the agent, via a system-prompt footer (Claude Code) or a
prepended block (Codex/custom), that this is a one-shot unattended session
and that it should act without asking for confirmation.

## Ending a run

A run ends on the first of these:

- **The agent signals it's done.** It runs the shell command
  `looper-done <status> "<headline>"` — `status` is `success` (everything
  done and verified), `warning` (done and verified, but a person must decide
  or act on something in the report, such as a decision, a credential, or
  access the agent doesn't have), or `error` (couldn't finish; list each
  method tried and what it showed); omitted means success. A check the agent
  skipped or couldn't get working counts as unfinished work, not a warning.
  It then writes its final message: a detailed Markdown report of what it
  did. For Claude Code in interactive mode, a `Stop` hook Looper injects
  captures that message the moment the turn ends, and the session is closed.
  The run's result in the log is whatever status you gave `looper-done`.
- **Idle timeout (Claude Code, interactive only).** If a turn finishes and
  the agent sits longer than `idleGraceMin` minutes without calling
  `looper-done`, the run ends as **Idle timeout** — or, if the task's
  `onIdleTimeout` is set to `hold`, it's held for a human instead (see
  below). The same clock also starts the moment any interactive prompt (a
  permission request, a question) is on screen, since the agent is then
  waiting on a human either way.
- **The agent process exits** on its own, with or without calling
  `looper-done` first. If it exits after signaling done but before its final
  message arrived, the run still ends as done, with the headline only (no
  report body).
- **`maxRuntimeMin` is exceeded**, regardless of what the agent is doing.

For Claude Code, the injected `Stop` hook also gates the end of a turn.
A turn ending with background tasks still running is blocked — the session
would close and kill them with no notification able to wake the agent — and
the agent is told to wait for their results or stop them first. A turn ending
without `looper-done` having been called gets one reminder to run it; if the
agent ends its turn again without it, the stop goes through (in interactive
mode, that's when the idle clock starts). Once `looper-done` has run, every
stop is allowed.

A subagent the agent starts (Claude Code's Agent tool) can't run
`looper-done`, `looper-complete`, or `looper-restart`. It shares the
session's PATH, so a `PreToolUse` hook Looper adds denies the call and tells
the subagent to report back instead: only the agent itself decides when the
run is done.

In `headless` mode there's no terminal to watch: process exit is the only
signal. The agent's final response becomes the report; `looper-done` still
names the headline if the agent ran it, otherwise the response's first line
does.

You can also end a run yourself with **Stop Task** (toolbar, Shift+F5, or
context menu) at any point in the cycle — checking, classifying, or running.
It kills whatever step is in flight and records the run as **Stopped**.

## Finishing the task for good

A task whose **Allow this task to be marked completed** option is on also gets
a `looper-complete "<why>"` command on the agent's PATH, and a line in the
system footer telling it when to use it: the task is finished for good, not
merely done for now. The agent runs it before `looper-done`; the run itself
ends exactly as it otherwise would, and Looper completes the task once the
cycle is over — the task stops being scheduled, moves to the completed-tasks
folder if one is set (Settings → General), and moves to the Recycle Bin when
the completed-task retention runs out. A run you stopped never completes the
task, and a task without the option never gets the command: a completion
signal from one is recorded in the run log and ignored.

The same option gates the manual action: Task → Complete is greyed out
without it. A scheduled task with a **Stop running on** date completes itself
once that date passes, option or not — the date is the instruction to stop.

## Context restarts

A long job can fill the agent's conversation until the harness compacts it
and the agent loses details. With **Restart the agent when its context passes
a limit** on (Settings tab, Claude Code and Codex), Looper reads the size of the
agent's conversation off its transcript every 5 seconds. Once it passes the
**Context limit**, Looper leaves the agent a notice asking it to restart as
soon as it can. The notice reaches the agent the same way as
[guidance](#guidance-for-a-run-in-progress): Claude Code gets it with its next
tool result or at the end of its turn, and an interactive session whose turn
has ended gets it typed in. If the conversation keeps growing, the notice
comes again at every further tenth of the limit.

The agent finishes the step it's on, runs `looper-restart "<reason>"`, and
writes a handoff as its final message: what's done, what's left, and what the
next session needs to know. Looper then ends that session and starts a new one
in the same run, in a new conversation. Its prompt is the task's prompt again
(with the run's guidance note, if any), followed by a
`## Continuing after a context restart` section that holds the handoff. The
run log records each notice and each restart (**Restarted**, with the handoff
as its text), and the run's result is the last session's.

- The run stays one run. The check and classifier don't run again, and
  **Max runtime** counts every session together: a restart after the max
  runtime is used up ends the run as **Timed out**.
- **Max restarts** (default 3) caps the restarts per run. The last session
  allowed gets neither the notice nor the `looper-restart` command, so it
  works on until it finishes.
- With **Continue previous across runs**, the next run resumes the newest
  session's conversation.
- The Terminal tab, `output.txt`, and `output.log` keep every session, with a
  line marking each restart, and the conversation window shows every
  session's conversation in order.
- Interactive Codex reports its conversation only when its first turn ends,
  so Looper measures it from then on, and it gets the notice only when a turn
  ends (it has no hook to take it mid-turn).

## Held for a human

When a Claude Code or Codex interactive run times out idle with `onIdleTimeout: hold`,
the run isn't ended — it's held. The task list shows **Needs attention** and
the status pane reads "The agent is waiting for you in the Terminal tab".
Nothing about the run is lost; it's still the same session, just paused for
input.

To resume it, open the task's **Terminal** tab and type your answer directly
into the running session — the moment you send input, the hold clears and the
idle clock resets. There's no separate "resume" button for this; it's driven
by the same terminal you'd use to watch the run. You can still **Stop Task**
a held run if you'd rather abandon it.

## Skipped, deferred, and manual runs

- **A task allows as many runs in flight at once as its "Simultaneous runs"
  setting** (task editor, Settings tab; default 1). Below that cap, a
  scheduled slot coming due while the task is already checking, classifying,
  or running starts another cycle alongside the ones in progress. At the cap,
  the due slot is recorded as skipped ("scheduled run skipped: N runs already
  active") and the next one is computed normally. **Run Now** (F5, toolbar,
  or context menu) follows the same cap: below it, Run Now starts another
  run even while one is active; at the cap it's refused outright and recorded
  as skipped, the same as a scheduled slot — it isn't retried automatically.
  The CLI/inbox `run` command behaves the same way. Run Now on a paused task
  also lifts the pause and clears its error count, the same as Resume. When
  more than one run of a task is in flight, the **Terminal** tab shows a run selector above the
  console so you can pick which one to watch and type into; the task's status
  and last-result always reflect whichever run finished most recently.
- **Concurrency limits defer, they don't skip.** An [environment or
  harness](environments.md) can cap how many tasks (counting each run of a
  task separately) run in it at once. A task that's due but over that cap
  simply stays due and is retried every tick until a slot frees up; nothing is
  logged as skipped for this.
- A **manual task** (Trigger tab set to "Manually only") never fires on
  its own; it only runs via Run Now, the toolbar, the context menu, or the
  CLI/inbox `run` command. `{{trigger}}` in your prompt is `"manual"` for
  these runs, `"timer"` for scheduled ones, and `"watcher"` for runs a
  watcher started.
- **A sleeping computer stops runs.** When Windows suspends while the desktop
  app is running, every run in flight is stopped (a held run is left alone,
  since it's waiting for you) and recorded as **Stopped**, without a
  notification. Its task is due again 20 seconds after the wake. Anything else
  that came due while the computer slept is pushed to 20 seconds after the
  wake as well, a second apart, so nothing starts before the network is back.
  Watchers stop at the suspend and restart after the same delay, followed by
  the "Run once when watching starts" catch-up run when that option is on. See
  [troubleshooting](troubleshooting.md#the-computer-went-to-sleep-during-a-run)
  for how a check or classifier that slept through its run is recorded.

## Run options for a manual run

With **Settings → General → Show run options before manually running a
task** on, Run Now (F5, the toolbar, the Task menu, or the context menu)
opens a Run Options window instead of starting the run. It has a
**Guidance** box at the top, prefilled with the task's
[one-off guidance note](#one-off-guidance-notes), and a checkbox for each
step to run: Check and Classifier (each shown only when the task has that
step turned on) and Agent. **Run** saves the guidance box as the task's note
(emptying it clears the note) and starts the run with only the checked steps;
it's greyed out while no step is checked. Cancel starts nothing.

A step you unchecked doesn't run at all, and the run's log records
"skipped by run options: …". Unchecking Agent ends the cycle after the
check and classifier, with "agent step skipped" as its detail. Folder
actions (Run All Now) and the CLI/inbox `run` command never open the
window.

## One-off guidance notes

You can attach one-off guidance to a task's next run(s) — via the toolbar
("Add/Edit Guidance for Next Run"), the Task menu, the context menu, or the
Run Options window. It's free text plus how many upcoming runs it applies to,
and it's appended to the classifier's and the agent's prompt as described
above.

Scripts see it too. Every step of a run that carries a note — check,
classifier, and agent — gets `LOOPER_NOTE_FILE`, the target-native path of
`note.txt` in the run directory. The file holds the note text exactly as
saved (UTF-8, no BOM), followed by one newline. On a run without a note the
variable is unset and the file doesn't exist, so a check can test for it
before acting:

```bash
if [ -n "$LOOPER_NOTE_FILE" ]; then note=$(cat "$LOOPER_NOTE_FILE"); fi
```

In PowerShell, read it with `Get-Content -Raw -Encoding UTF8 $env:LOOPER_NOTE_FILE`.
The run carries the note as it was when the run started; editing it mid-run
changes the next run, not this one. A continuation run (Continue with
Guidance… on a finished run) carries no note: its prompt is your guidance itself.

Each run whose agent actually received the note uses up one of those charges;
once it reaches zero the note is cleared. A run does **not** spend a charge
if it never got the note to a running agent in the first place — an
engine-level error before or instead of the agent doing any work (a spawn
failure, a Claude Code usage-limit rejection) or a run you stopped yourself.
Any other ending — including the agent finishing and reporting
`looper-done error` — does consume the charge, since the agent did receive
and act on the guidance even if it didn't succeed.

Only the agent spends a charge. A check that returns `act: false`, a
classifier that says no, or an agent step switched off in Run Options leaves
the note in place for the next run, whose check sees it again. A check that
acts on the note itself should therefore return `act: true`, so the run's
agent uses up the charge.

## Guidance for a run in progress

While a Claude Code or Codex agent is running, you can send it guidance
without stopping it: the send box under the run window's conversation
(Ctrl+Enter sends), **Send Guidance…** on a run's context menu in the Runs
tab, the inbox `guide`
command, or `looper guide <taskId> <text>`. Text sent before the agent picked
up the previous one is appended to it.

The guidance waits as `guidance.json` in the run directory until the agent
gets it:

- **Claude Code** gets it with the result of its next tool call (a
  `PostToolUse` hook Looper adds to the run's settings), or, if it ends its
  turn first, through the Stop hook, which keeps the turn going with the
  guidance. Once `looper-done` has run, the Stop hook lets the turn end. A
  subagent's tool call never takes it: the guidance waits for the agent's own
  next call.
- **An interactive session that has ended its turn** (idle or held) gets the
  guidance typed in as its next prompt, the same as typing it in the Terminal
  tab yourself.
- **Headless Codex** gets it with its next tool result through a hook, once
  you've trusted that hook in Codex. Codex skips a hook nobody has trusted.
  Every run uses the same hook command, so you trust it once per Codex home
  (WSL and Windows each have their own): run
  `codex -c "hooks.PostToolUse=[{hooks=[{type='command',command='<the command>'}]}]"`
  with the command from a run's `run.sh`/`run.ps1`, type `/hooks`, and trust
  it. **Interactive Codex** gets no hook (its TUI would open on the hook
  review screen and wait there); it gets the guidance typed in when its turn
  ends.

The conversation window shows waiting guidance as a muted "Waiting for the
agent" row, and delivered guidance as a **Guidance** row. The run log records
when the guidance was sent and when it was delivered.

If the agent finishes before reading waiting guidance, Looper continues the
conversation in a new run with the guidance as its prompt, exactly like
**Continue with Guidance…**. A run that ended any other way (stopped, failed,
timed out, exited) or whose task is paused keeps the guidance in its log
only, as **Not delivered**.

## Continuing a finished run

A finished Claude Code or Codex run whose conversation was recorded can be
picked up again from its context menu in the Runs tab, or from the run
window's File menu:

- **Continue in Terminal** opens a real OS terminal in the task's
  environment and working directory with the harness resuming that
  conversation (`claude --resume <id>` / `codex resume <id>`), with the
  task's model and permission mode. Looper doesn't track what you do there.
- **Continue with Guidance…** opens a Continue Run window with a Guidance
  box. **Continue** starts a new manual run that resumes the conversation
  with your guidance as its whole prompt. The check and classifier don't
  run, the task's one-off note is left untouched, and the run counts toward
  the task's Simultaneous runs cap like any Run Now.

Both items are greyed out while the run is still in progress, for custom
harnesses, and for runs that never recorded a conversation.
