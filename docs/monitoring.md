# Monitoring and controlling tasks

## The main window

The sidebar lists your tasks by name, with a status line under each one:
what it's doing right now if active, otherwise a next-run countdown, "Not
scheduled", "Manual", its paused reason, or "Disabled". Selecting a task
opens its detail pane with three tabs — Status, Run log, Terminal — plus a
status bar at the bottom counting enabled, disabled, paused, and running
tasks.

The Status tab lists the task's current state as plain fields: Status,
Schedule, Next run, Next run guidance (when a one-off note is set), Last
run, Last run result, Last run details, Check command, Classifier (Yes/No),
Harness, Model, Session type, Environment, and Working directory.

The View menu controls what the window shows: a Standard or Compact task
list, whether disabled/scheduled/manual tasks are listed at all, whether
runs with no action are hidden in every task's run log, and whether the
toolbar and status bar themselves are shown.

## The toolbar

The toolbar acts on the selected task. Buttons, left to right, with their
tooltips:

| Button | Tooltip | Shortcut |
|---|---|---|
| Run | Run Now | F5 |
| Stop | Stop Task | Shift+F5 |
| Pause/Resume | Pause / Resume | Ctrl+P |
| Power | Enable / Disable | — |
| Edit | Edit Task | Ctrl+E |
| Guidance | Add Guidance for Next Run / Edit Guidance for Next Run | — |
| Terminal | Open Project in Terminal | Ctrl+T |
| Folder | Open Working Directory | — |

Running Now on a disabled task asks '"<task name>" is disabled. Run it
anyway?' first. Pause/Resume and Enable/Disable swap their tooltip and icon
depending on the task's current state. "Open Project in Terminal" opens a
real OS terminal window with the task's environment, working directory, and
harness ready to go (model and permission mode included, no prompt) — a
different thing from the in-app Terminal tab described below.

## The context menu

Right-clicking a task in the sidebar selects it and opens a context menu
with the same actions as the toolbar, plus a few more: Run Now, Stop Task,
Pause/Resume, Enable/Disable, Edit/Add Guidance for Next Run…, Clear
Guidance, Open Project in Terminal, Open Working Directory, Edit Task…,
Clear Run History…, and Delete Task.

## The terminal tab

The Terminal tab is a live view of the task's agent session — a real
terminal (xterm) you can watch and type into while a run is in progress.
Before any run it shows "No agent session for this task yet. Output appears
here when one starts." Each new run resets the view with a `── run <id> ──`
marker and closes with `── session ended ──`.

For a **headless** run (`agent.mode: headless`) the same tab still shows the
streamed output, but there's nothing to type into — the process reads no
input, so keystrokes go nowhere.

If the agent finishes a turn without signaling and the task is set to hold,
a banner appears: "The agent finished a turn without calling `looper-done`
and this task is set to hold. Type into the terminal to continue it, or
press Stop agent."

## The run log

The Run log tab lists every past run of the task as a table: Date, Start,
End, Result, Duration, Details. Each row is one full run (check, classify,
and agent steps collapsed together, showing the most significant result).
Selecting a row shows that run's final report below in a resizable split
pane. Double-clicking a row, or right-clicking it and choosing "View
Details", opens the run detail window described below. The
context menu also offers "Copy Details" and "Open Run Folder"; Ctrl+C
copies the selected row's details text.

## The run detail window

Opened from a run log row, this window breaks one run into its phase rows —
check, classify, agent, result — each with Time, Phase, Result, Duration,
and Details (including cost in dollars when the harness reports it).
Clicking a row shows that phase's captured output below: the agent phase
shows the run's terminal output, cleaned of ANSI codes and, for headless
runs, pretty-printed if it looks like JSON.

The window's own menu bar adds a File menu (Open Output File, Open Run
Folder, Open Working Directory) and a View menu with a "Raw Terminal Log"
checkbox — the raw-output toggle — which switches the display between the
cleaned output and the untouched raw terminal capture.

## The engine log window

**Advanced → Engine Log** opens a window listing the engine's own
diagnostic log as a table (Date, Time, Level, Message), refreshed every two
seconds; selecting a row shows its full message below. Entries older than
**Settings → Advanced → Engine log retention** (default 10 days) are pruned
automatically. This is separate from a task's run log, which is pruned by
its own **Run log retention** setting (default 30 days).

## System notifications

Looper can show a system toast for several points in a task's cycle: a run
starting, the agent starting, the agent holding for input, the task
auto-pausing, a usage limit being hit, and the task ending (with a
configurable severity threshold). Each task chooses which of these it sends
on its Notifications tab — see [the task editor](tasks.md) for the field
list; by default only errors and warnings at the end of a run notify.

A master switch lives in **Settings → General → Show notifications**, and
the same toggle is available from the tray menu as "Enable Notifications" /
"Disable Notifications". Clicking a toast opens the task: for a live run
(run started, agent started, held) it opens the Terminal tab; for a
finished cycle (end, auto-paused, usage limit) it opens the Run log tab
with that run selected. No toast fires while any Looper window is focused.

## The tray icon and close-to-tray

Looper keeps a tray icon running whenever the app is open. Double-clicking
it shows the main window; right-clicking it opens a menu with Show Looper,
Enable/Disable Notifications, and Quit.

By default, closing the main window quits Looper — and stops any running
agents. Turning on **Settings → General → Close to system tray** changes
that: closing the window just hides it, and the engine (and any running
tasks) keeps going in the background. `looper --hidden` starts straight
into the tray without opening the window, which is also what **Settings →
General → Start with the computer** registers as a login item.
