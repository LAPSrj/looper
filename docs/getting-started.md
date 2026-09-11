# Getting Started

Looper runs AI agents on a schedule, the way cron runs scripts. Each task
pairs a schedule with an optional cheap check (a script, and optionally a
small classifier model) that decides whether there is work to do. Only when
the check says yes does Looper start a fresh agent session — Claude Code,
Codex, or any other agent CLI — in a real terminal you can watch and type
into.

The point is to avoid an agent that polls for its own work: that wastes
tokens on every empty check and eventually fills its context with polling
noise. Looper keeps the polling outside the agent, so at most one agent
session runs per task, and every session starts clean.

## Installing and running

No compiler toolchain is needed on any platform — the terminal component
ships prebuilt binaries that work as-is.

**Packaged Windows installer**

Build the installer from source:

```bash
npm install
npm run package
```

This produces an NSIS installer under `release/win-x64/`. Run it; the
installer's shortcut registers Looper's Start Menu entry and app identity, so
notifications show the Looper name and icon out of the box.

**Running from source**

```bash
npm install
npm run dev            # Electron app with hot reload
```

Or build once and run the built app:

```bash
npm run build:all      # out/ (app) + out/cli/ (CLI + terminal worker)
npm start               # electron-vite preview
```

If you run an unpackaged build on Windows, notifications and the taskbar
icon are attributed to Electron until you register the app identity once
per machine:

```bash
npm run register:notifications
```

This is unnecessary once you use the packaged installer, which does it for
you.

## First launch

On first launch, with no settings file yet, Looper creates a starting
configuration for you:

- A **Local Shell** environment (the native shell of the machine Looper runs
  on) with a **Claude Code** harness already pointed at the `claude` command.
- If your machine has a reachable bridge, that environment too: a **WSL**
  environment when Looper runs on Windows, or a **Windows (PowerShell)**
  environment when it runs inside WSL.

You can see and edit these under File → Settings…; see
[environments](environments.md) for details. The main window opens with an
empty task list, a toolbar, and a status bar showing how many tasks are
enabled, disabled, paused, or running.

## Creating your first task

Open File → New Task… (Ctrl+N) for a blank task, or File → New Task from
Template… (Ctrl+Shift+N) to pick a starting point from your saved templates
(see [task templates](tasks.md#task-templates)). Either way, a task editor
window opens.

At minimum, fill in:

- **General tab** — Task name, and Working directory (the folder the check
  and agent run in; use Browse… to pick it). Environment defaults to your
  default environment, but confirm it points where you want the task to run.
- **Agent tab** — Agent prompt. This is the only field the agent step
  strictly requires.
- **Check tab** — either fill in Command, or turn off "Run a command to
  check whether the agent should run" so every scheduled slot goes straight
  to the agent.

![The task editor's General tab](img/task-editor-general.png)

Everything else — schedule, classifier, notifications — has a working
default. Click Save. See the [task editor](tasks.md) reference for every tab
and field.

## Running it

![The main window with a task selected](img/main-window.png)

Select the task in the sidebar and click Run Now (or press F5, or use
Task → Run Now). Switch to the task's Terminal tab to watch the agent work
in a real pty — you can type into it if the agent is waiting on you. The
Status tab shows the task's current state and last result; the Run log tab
lists every past run with its check/classifier/agent outcome. See
[how a run works](how-a-run-works.md) and [monitoring](monitoring.md) for
what to expect during and after a run.

## Where to go next

- [Task editor reference](tasks.md) — every tab and field, prompt
  templates, and task templates.
- [How a run works](how-a-run-works.md) — the check → classify → agent
  pipeline and how a run ends.
- [Environments](environments.md) — local shell, WSL, and Windows bridges,
  and the harnesses (agent CLIs) inside them.
- [Monitoring](monitoring.md) — the terminal tab, run log, and
  notifications.
- [CLI and automation](cli-and-automation.md) — driving Looper from a
  shell or from another agent.
- [Troubleshooting](troubleshooting.md) — common problems and fixes.
