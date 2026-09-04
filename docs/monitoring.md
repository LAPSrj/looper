# Monitoring and controlling tasks

## The main window

The sidebar lists your tasks by name, with a status line under each one:
what it's doing right now if active, otherwise a next-run countdown, "Not
scheduled", "Manual", its paused reason, or "Disabled". Selecting a task
opens its detail pane with four tabs — Status, Run log, Messages, Terminal —
plus a status bar at the bottom counting enabled, disabled, paused, and
running tasks.

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
context menu also offers "Copy Details", "View Messages" (the run's
conversation window), and "Open Run Folder"; Ctrl+C copies the selected
row's details text.

## The messages tab

The Messages tab lists the task's runs that reached the agent step — Date,
Start, Result, Details, newest first. Double-clicking a run (or pressing
Enter on it) opens that run's conversation in its own window, read straight
from the harness's own session transcript (Claude Code harnesses only —
other harnesses record no transcript).

In the conversation window each row is one message or tool call — Time,
Type, Details — where Type is Prompt, Agent, Thinking, or the tool's name;
the Type column can be resized by dragging its header edge (the width is
remembered; double-click the edge to reset it). Clicking a row
shows its full content in the split pane below: prompts and agent replies
render as Markdown, thinking as plain text, and tool calls as Input and
Result tabs (opening on Result once the tool has finished). Several tools
get tailored renders: Edit shows the change as a red/green diff, Bash
shows the command as a terminal block and its output with escape codes
stripped, Read results get a line-number gutter, TodoWrite renders as a
checklist, Task shows its prompt and the subagent's report as Markdown,
web tools link their URL, file searches list one file per line
(right-clickable to open), and JSON results render as a collapsible tree. While the run
is live the table refreshes every two seconds and follows the newest
message unless you've scrolled up.

Right-clicking a row offers Copy Content, and on rows for file tools
(Read, Edit, Write) also Open File and Copy Path; on Task rows, Open
Subagent Conversation.

The window's menu bar has a File menu (Open Run Folder, Open Working
Directory) and a View menu. View starts with Raw Messages — every
transcript record shown verbatim as pretty-printed JSON, nothing skipped —
then filters what the table lists: Show Messages, Show Thinking, Show Tool
Usage, and Show Subagents (all on by default), plus Filter… (Ctrl+F),
which opens a small modal Filter window — only rows whose content matches
stay visible, the menu item shows a checkmark while a filter is active,
and the window's Clear Filter button removes it. Ctrl+Up and Ctrl+Down
jump between prompt rows.

When a tool result is an image (a Read of a screenshot, for example), the
Result tab shows the image itself, fitted to the pane. Double-clicking the
image or its row opens it in an image window with zoom controls (−, +, and
an editable percentage; it opens fitted to the window).

When the agent delegates work with the Task tool, that row can be opened as
its own conversation: double-click it, or use the "Open Subagent
Conversation" button in its detail pane. The subagent window is the same
rows-plus-panel view and also updates live. The link becomes available once
the subagent has reported back to the parent.

Messages come from the transcript files under the harness's own data
directory, so they live and die with it: transcripts cleaned up by Claude
Code (30 days by default) show "The session transcript is no longer
available."

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
