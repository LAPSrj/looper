# Troubleshooting

## A task keeps failing and auto-pauses

Each run that ends in error — a bad check exit, a malformed classifier
response, an agent that reported `looper-done error`, a crash — increments
the task's consecutive-error count. Once that count reaches the task's
"Auto-pause after" setting (5 by default, on the Settings tab of the
[task editor](tasks.md)), the task auto-pauses with a reason like
"auto-paused after 5 consecutive errors" and stops scheduling itself.

**Resume** it (toolbar, context menu, or `looper resume <taskId>`) to clear
the error count and the paused reason and put it back on its schedule. A
single successful run also resets the count on its own, so occasional
failures that don't repeat five times in a row never trigger this. A pause,
automatic or manual, isn't kept across a restart: when Looper starts again,
the task starts idle on its schedule.

A Claude Code usage-limit hit, a network error, an environment error, and a
run the computer slept through do **not** count toward this — see below.

## Claude Code says you've hit your usage limit

When Claude Code rejects a request because you're over your usage limit —
the "hit your … limit · resets …" banner on an interactive screen, or the
equivalent rejected event in a headless run's output — Looper ends that run
as an error, but treats it specially:

- It automatically retries the task at the time the banner advertised (plus a
  short safety margin), not on the task's normal schedule.
- It does **not** count toward the auto-pause threshold above.
- It does **not** consume a one-off guidance note charge (see
  [how a run works](how-a-run-works.md)), since the agent never got to act on
  the prompt.

If the task has the "Usage limit" notification enabled, you'll get a toast
when this happens; otherwise the task list just shows the task idle with a
countdown to the retry.

## The computer was offline when a task ran

Looper looks for a network problem at each step of a cycle:

- **Check** — the check command exited non-zero or timed out with a message
  that looks like a network failure (`ENOTFOUND`, "Could not resolve host",
  and similar), or, failing that, a connectivity probe of `api.anthropic.com`
  finds the machine offline.
- **Classifying and running** — a Claude Code session that hit the
  "API Error: Can't reach the API server — check your internet or DNS" banner
  (interactive), or a headless run whose result reports an API error with no
  HTTP status.

When this happens, the run log shows the cycle as **Error**, with a detail
that starts with "no network: ". Like a usage-limit hit:

- It does **not** count toward the auto-pause threshold above.
- It does **not** consume a one-off guidance note charge (see
  [how a run works](how-a-run-works.md)), since a network error caught before
  the agent acted means the agent never got to act on the prompt.
- A scheduled run is retried within minutes instead of waiting for the next
  slot (see [below](#a-scheduled-run-the-computer-failed-is-retried)).

Unlike a usage-limit hit, no end notification fires for these runs by
default — a blip in your connection shouldn't page you. Turn on
"Include network errors" in the task's Notifications tab to get one anyway.

An HTTP 404, 401, or 403, or a plain "invalid credentials" rejection, is
**not** a network error — those are ordinary errors and count toward
auto-pause as usual.

## WSL couldn't start a step

A task in a WSL environment starts every step (check, classifier, agent,
watcher) through `wsl.exe`. Sometimes WSL itself fails before the step runs:
the VM doesn't answer in time and wsl.exe gives up after about 30 seconds
with `Error code: Wsl/Service/WSAETIMEDOUT` (seen when the VM's memory was
too fragmented to open a new session), or wsl.exe is missing for a moment while
a WSL update replaces it (`spawn wsl.exe ENOENT`). Looper recognizes these by
wsl.exe's own error code (`Wsl/…`) or the missing-wsl.exe spawn error.

When this happens, the run log shows the cycle as **Error**, with a detail
that starts with "environment unavailable: ". Like a network error:

- It does **not** count toward the auto-pause threshold above.
- It does **not** consume a one-off guidance note charge, since the step
  never started.
- No end notification fires unless "Include environment errors" is on in the
  task's Notifications tab.
- A scheduled run is retried within minutes instead of waiting for the next
  slot (see [below](#a-scheduled-run-the-computer-failed-is-retried)).

A watcher WSL couldn't start is restarted with the usual backoff without
counting toward auto-pause, and wsl.exe's error message is never delivered
as trigger events.

A task whose WSL distro doesn't exist (`WSL_E_DISTRO_NOT_FOUND`) is **not**
an environment error: that's the task's configuration, so it's an ordinary
error and counts toward auto-pause as usual.

## A scheduled run the computer failed is retried

When a scheduled run ends with a network or environment error, Looper tries
it again 2 minutes later, then after 5, 15 and 30 minutes, and every 30
minutes after that, until a run gets through or the task's next regular slot
comes first. The task list shows the time of the next try after the error
("…; retrying at 9:32 AM"), and the retry's run log starts with the error it
retries.

The retry starts at the step that failed. A check or classifier that already
passed doesn't run again, and the agent gets the check's original summary and
context, so a check that changes things (a sync that pushes data, for
example) runs only once per slot.

Only scheduled runs are retried. A manual run or a pause cancels a pending
retry, and editing the task makes the retry run every step again. A pending retry doesn't survive a restart of Looper.

## The computer went to sleep during a run

A run can't survive the computer sleeping: its processes and WSL sessions
die, or come back broken at the wake. When the desktop app sees Windows
suspend, it stops every run in flight except a held one, records it as
**Stopped** without a notification, and runs the task again 20 seconds after
the wake. Work that came due during the sleep waits the same 20 seconds, so
it doesn't start before the network is back.

Where no suspend was seen (for example on other platforms, or under
`looper serve`), a check or
classifier that failed after running more than two minutes past its timeout
is taken to have slept through the run. The run log shows it as **Error**,
with a detail that starts with "slept through the run: ", and the task runs
again 20 seconds later. Like a network error, it doesn't count toward
auto-pause, and no end notification fires unless "Include network errors" is
on.

## The "trust this folder?" dialog

Interactive Claude Code asks whether it can trust a directory the first time
it runs there, and blocks until answered (Codex asks the same about a
directory's contents). Looper answers "yes" for you
automatically (the harness's **Folder trust dialog** setting in
**Settings → Environments**, "Answer automatically (recommended)" by
default) — you shouldn't normally see this
dialog at all. If you've set it to "Wait for user" for a harness, the run will
sit waiting on it until the idle clock (below) ends or holds it.

## An interactive run holds on a permission prompt

Any interactive prompt on screen — a permission request, a question, not
just the trust dialog — is detected by watching for its "Esc to cancel"
footer, and is treated as the agent waiting on a human: the idle clock
starts, and after `idleGraceMin` minutes (the Settings tab's **Idle
grace**) the run ends, or holds if the task's **When idle too long** is set
to "Hold and wait for me" (`onIdleTimeout: hold`).

Even `--permission-mode auto` has been observed still prompting before
creating a file. For a task you want to run fully unattended:

- Set the agent's permission mode to Accept edits (`acceptEdits`), or pass
  `--allowedTools …` in the agent's extra args, so it never needs to ask.
- Or leave prompts possible but set **When idle too long** to "Hold and wait
  for me", and answer
  the prompt yourself in the task's Terminal tab when it comes up — see
  [how a run works](how-a-run-works.md) for what a held run looks like.

## Runs show as "interrupted" after a restart

If Looper is closed or crashes while a task is checking, classifying, or
running, that run is logged as **Interrupted** the next time Looper starts.
Looper doesn't try to resume or reattach to it — the task simply returns to
idle and picks up its schedule from there. A scheduled task whose slot
passed while Looper was closed runs once soon after startup; with
**Settings → General → Stagger overdue tasks on startup** on (the default),
those catch-up runs are spread out over the first minutes instead of all
starting together.

## Stopping a task mid-cycle

**Stop Task** (toolbar, Shift+F5, or context menu) works at any point in the
cycle: it kills a running check or classifier script, or ends a running
agent, and records the run as **Stopped**. The task returns to idle at its
next due slot, same as any other finished cycle.

## Notifications don't appear on unpackaged Windows runs

An unpackaged run (`npm run dev`, or `electron .`) on Windows is attributed
to `electron.exe`, so Windows won't show its notifications correctly — no
proper name/icon on the toast, and it may not attribute them to Looper at
all. Run this once per machine:

```bash
npm run register:notifications
```

It creates a Start Menu shortcut carrying a dev-only AppUserModelID plus the
matching toast registry entries. This is a one-time, per-machine setup step;
the packaged installer's own shortcut does this automatically, so installed
copies of Looper never need it.

## Known limitations

- **`custom` harnesses have no idle detection and no detailed interactive
  report.** The turn-end signal is harness-specific (Claude Code's Stop hook,
  Codex's notify hook) and a custom CLI has neither. Interactive runs on a
  custom harness end only via `looper-done` (headline only, no report body),
  the process exiting, or `maxRuntimeMin`.
- **Sandboxed codex through the WSL→Windows bridge can't run `looper-done`.**
  When Looper runs inside WSL and the task targets Windows, the run directory
  reaches Windows as a `\\wsl.localhost\…` share — and codex's Windows sandbox
  blocks network shares, so the sandboxed session can't see the helper or
  write the signal file (`--add-dir` with such a path would break its shell
  outright, so Looper omits it there). The run still finishes: headless via
  the final report in the stream, interactive via the notify hook and the
  idle grace. Permission modes Bypass and Full access are unaffected, and so
  is the normal setup of Looper running on Windows (local run dirs work with
  the sandbox). Codex CLI 0.154.
- **No SSH or other remote environments.** Looper's environments are the
  local shell and the WSL↔Windows bridge pair, which share a filesystem —
  that's how the `looper-done`/Stop signal files cross between the two
  sides. A true remote environment would need a different signal transport
  and isn't implemented.
- **Closing the window quits Looper, and stops any running agents,** unless
  "Close to system tray" is turned on in Settings. With that on, closing the
  window just hides it; `looper --hidden` starts straight into the tray, and
  Settings → "Start with the computer" registers exactly that as a login
  item.
