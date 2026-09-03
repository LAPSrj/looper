# Looper User Guide

Looper runs AI agents on a schedule, the way cron runs scripts. A cheap check
script (and optionally a small classifier model) decides whether there is
work; only then does a fresh agent session — Claude Code, Codex, or any other
agent CLI — start in a real terminal you can watch and type into. No idle
polling inside the agent, no context buildup, at most one agent per task.

## Contents

- **[Getting started](getting-started.md)**: what Looper is and how to
  install it, launch it for the first time, and create and run your first
  task.
- **[The task editor](tasks.md)**: every tab and field of the task editor,
  plus task templates, import/export, and the prompt template variables.
- **[How a run works](how-a-run-works.md)**: the check → classify → agent
  cycle: the check and classifier contracts, how the agent's prompt is
  built, every way a run can end, held runs, and one-off guidance notes.
- **[Environments](environments.md)**: environment kinds (local shell,
  WSL, Windows), the WSL shell and mount-prefix settings, harnesses and
  their models, and concurrency caps.
- **[Monitoring](monitoring.md)**: the task list, toolbar and context-menu
  actions, the live terminal tab, the run log and run detail windows, the
  engine log, notifications, and the tray.
- **[CLI and automation](cli-and-automation.md)**: the `looper` CLI, the
  inbox drop-folder protocol for scripts and agents, `looper serve`, and a
  tour of the `~/looper` data directory.
- **[Troubleshooting](troubleshooting.md)**: fixes for auto-pause, usage
  limits, permission prompts, restart artifacts, and Windows notification
  setup, plus the current known limitations.

New to Looper? Read [Getting started](getting-started.md), then skim
[How a run works](how-a-run-works.md) — the rest is reference.
