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
failures that don't repeat five times in a row never trigger this.

A Claude Code usage-limit hit and a network error are two errors that do
**not** count toward this — see below.

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

Unlike a usage-limit hit, no end notification fires for these runs by
default — a blip in your connection shouldn't page you. Turn on
"Include network errors" in the task's Notifications tab to get one anyway.

An HTTP 404, 401, or 403, or a plain "invalid credentials" rejection, is
**not** a network error — those are ordinary errors and count toward
auto-pause as usual.

## The "trust this folder?" dialog

Interactive Claude Code asks whether it can trust a directory the first time
it runs there, and blocks until answered. Looper answers "yes" for you
automatically (this is the harness's "auto-trust workspace" option in
**Settings → Environments**, on by default) — you shouldn't normally see this
dialog at all. If you've turned that option off for a harness, the run will
sit waiting on it until the idle clock (below) ends or holds it.

## An interactive run holds on a permission prompt

Any interactive prompt on screen — a permission request, a question, not
just the trust dialog — is detected by watching for its "Esc to cancel"
footer, and is treated as the agent waiting on a human: the idle clock
starts, and after `idleGraceMin` minutes the run ends (or holds, if the
task's "On idle timeout" is set to `hold`).

Even `--permission-mode auto` has been observed still prompting before
creating a file. For a task you want to run fully unattended:

- Set the agent's permission mode to `acceptEdits`, or pass
  `--allowedTools …` in the agent's extra args, so it never needs to ask.
- Or leave prompts possible but set "On idle timeout" to `hold`, and answer
  the prompt yourself in the task's Terminal tab when it comes up — see
  [how a run works](how-a-run-works.md) for what a held run looks like.

## Runs show as "interrupted" after a restart

If Looper is closed or crashes while a task is checking, classifying, or
running, that run is logged as **Interrupted** the next time Looper starts.
Looper doesn't try to resume or reattach to it — the task simply returns to
idle (or paused, if it was configured that way) and picks up its schedule
normally from there.

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

- **`codex` and `custom` harnesses have no idle detection and no detailed
  interactive report.** The Stop hook and the on-screen prompt check are
  Claude Code specific. Interactive runs on these harnesses end only via
  `looper-done` (headline only, no report body), the process exiting, or
  `maxRuntimeMin`. The `codex exec` headless form hasn't been tested against
  a real Codex install yet.
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
