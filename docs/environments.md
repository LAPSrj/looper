# Environments

**Settings → Environments** defines where Looper runs your checks and agents,
and which agent CLIs are available there.

## What an environment is

An environment is either the shell Looper itself runs in, or a bridge to
another one:

- **Local Shell** — the native shell of the machine Looper runs on: bash/zsh
  on Linux/macOS, PowerShell on Windows. Most users only need this one.
- **WSL distro** — a WSL distro, reached from a Windows host through
  `wsl.exe`.
- **Windows (PowerShell)** — native PowerShell, reached from inside WSL
  through Windows interop.

The environment editor's Type dropdown only lists the kinds your machine can
actually reach. On Windows that's Local Shell and WSL distro; inside WSL
it's Local Shell and Windows (PowerShell); everywhere else it's Local Shell
only. If you pick a WSL distro, a second dropdown lets you choose which one
(or leave it on "Default distro").

Environments live in a plain list: Add, Edit, Duplicate, Remove. Add creates
the environment immediately with a default Claude Code harness; closing the
editor without saving removes it again.

## Shell (WSL and non-Windows Local Shell)

Any environment that runs a POSIX shell — a WSL distro, or a Local Shell on a
non-Windows host — has a Shell setting on its Advanced tab:

| Option | Command | Effect |
|---|---|---|
| Same as your terminal (default) | `bash -lic` | Reads `~/.bashrc`, so tools whose installers only edit that file (nvm, bun) resolve without changes. Two harmless job-control warnings bash prints without a terminal are stripped from the captured output. |
| Basic shell, without your terminal setup | `bash -lc` | Reads only `~/.profile` and prints no warnings, but anything a check command or harness needs must be on the PATH that sets. |
| Custom | any shell and flags, e.g. `zsh -lc` | — |

This matters because the check script and the agent both run through this
shell: if a tool resolves in your interactive terminal but not in a task,
the Shell setting is usually why.

## Advanced: mount prefix

WSL and Windows (PowerShell) environments — the ones that bridge two
filesystems — have a "Windows drive mount prefix" field on their Advanced
tab, default `/mnt`. It's how the WSL side reaches the Windows drives (and
vice versa); change it only if your setup mounts them somewhere else. The
field's placeholder shows the prefix Looper actually detected for that
distro.

## Harnesses

Each environment holds one or more **harnesses** — agent CLIs installed
there. Manage them from the environment editor's Harnesses tab (Add, Edit,
Duplicate, Remove; at least one is required).

A harness has a Type:

- **Claude Code** gets full integration: `--model` and `--permission-mode`
  flags built from the task's Agent tab, an injected system prompt, idle
  detection (ends or holds a run that goes quiet after a turn), and a
  per-harness "Folder trust dialog" setting — "Answer automatically
  (recommended)" or "Wait for user" — for the first-run trust prompt Claude
  Code shows for a new working directory.
- **Codex** and **Custom** are invoked as `command [args…] "<prompt>"`, with
  Looper's instruction footer prepended to the prompt. `looper-done` is on
  PATH for all three kinds.

Each harness has its own Command, Default arguments, and Shell environment
variables — handy for two installs of the same tool under different
accounts or config directories. A harness can also cap "Limit concurrent
tasks" independently of its environment (see below).

## Models

A harness's Models tab holds the preset list that fills the Model dropdown
on a task's Agent tab. Add/Edit/Remove each entry (a model id plus an
optional display name). Left at its default, a harness offers the CLI's main
models by their unprefixed ids:

- Claude Code: Fable, Opus, Sonnet, Haiku
- Codex: GPT-5.1 Codex Max, GPT-5.1 Codex Mini, GPT-5.1
- Custom: no presets

A task can still type any other model id as "Custom…" in its Model dropdown.

## Limiting concurrent tasks

Both an environment and a harness have a "Limit concurrent tasks" checkbox
(off by default) plus a "Maximum concurrent tasks" count when it's on. A
task counts against its environment's limit — and its chosen harness's — for
its whole cycle: checking, classifying, and running.

When a scheduled slot arrives and the environment or harness is already at
its cap, the task simply stays due and is retried on every following tick
until a slot frees up — it isn't skipped. A manual Run Now against a full
cap is rejected instead (logged as skipped) rather than queued.

## Which environment and harness a task uses

A task picks its environment on the editor's **General** tab, and one of
that environment's harnesses on the **Agent** tab (blank picks the
environment's first harness). The Agent tab is also where you set the
model, session type (interactive or headless), and — for Claude Code — the
permission mode; see [the task editor](tasks.md) for the full field list.

The optional classifier step always runs on a Claude Code harness (headless
`claude -p` by default, or an interactive session — its own Session type
field). Left blank, its Harness field on the Classifier tab resolves to the
task's own harness if that's Claude Code, otherwise the environment's first
Claude Code harness; you can also pick a specific harness (and model) there
explicitly.

## Default environments

On first launch Looper creates a "Local Shell" environment (id `local`,
set as the default environment) plus the reachable bridge: a "WSL"
environment if the host is Windows, or a "Windows (PowerShell)" environment
if the host is WSL. Each starts with one harness, "Claude Code", running the
`claude` command with no extra arguments.

## Everything is a fresh session

No environment or harness setting changes this: every run starts a brand
new agent session, with no memory of previous runs. Put anything the agent
needs to remember between runs in the project's `CLAUDE.md`. See
[how a run works](how-a-run-works.md) for the full run lifecycle.
