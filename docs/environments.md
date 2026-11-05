# Environments

**Settings → Environments** defines where Looper runs your checks, agents and
[addons](addons.md#changing-how-an-addon-runs), and which agent CLIs are
available there.

## What an environment is

![Settings → Environments](img/settings-environments.png)

An environment is either the shell Looper itself runs in, or a bridge to
another one:

- **Local Shell** — the native shell of the machine Looper runs on: bash/zsh
  on Linux/macOS, PowerShell on Windows. Most users only need this one.
- **WSL distro** — a WSL distro, reached from a Windows host through
  `wsl.exe`.
- **Windows (PowerShell)** — native PowerShell, reached from inside WSL
  through Windows interop.

![The environment editor](img/environment-editor.png)

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

![The harness editor](img/harness-editor.png)

Each environment holds one or more **harnesses** — agent CLIs installed
there. Manage them from the environment editor's Harnesses tab (Add, Edit,
Duplicate, Remove; at least one is required).

A harness has a Type:

- **Claude Code** gets full integration: `--model` and `--permission-mode`
  flags built from the task's Agent tab, an injected system prompt, idle
  detection (ends or holds a run that goes quiet after a turn), rolling
  conversations, and a per-harness "Folder trust and MCP server dialogs"
  setting — "Answer automatically (recommended)" or "Wait for user" — for the
  first-run trust prompt Claude Code shows for a new working directory and
  its prompt to approve the folder's project MCP servers (`.mcp.json`). Two
  more settings go with [Remote Control](monitoring.md#remote-control):
  **Start new conversations with Remote Control** (chats and Looper
  terminals on the harness start with it while it's on, so the Claude app can
  drive them) and **Close idle Remote Control conversations once their
  prompt cache expires** (on by default).
- **Codex** gets the same level of integration through its own mechanisms:
  `--model` and sandbox/approval flags from the Agent tab, headless runs
  through `codex exec --json`, idle detection and the final report through
  codex's notify hook, rolling conversations through `codex … resume`, the
  classifier through `--output-schema`, the run window's conversation from
  its rollout transcripts, and the same "Folder trust dialog"
  auto-answer. Looper's instruction footer is prepended to the prompt (codex
  has no system-prompt flag), and interactive sessions run in codex's inline
  scrollback mode so the captured output stays readable.
- **Custom** is invoked as `command [args…] "<prompt>"`, with the footer
  prepended; a run ends via `looper-done`, process exit, or the max runtime.

`looper-done` is on PATH for all three kinds.

Each harness has its own Command, Default arguments, and Shell environment
variables — handy for two installs of the same tool under different
accounts or config directories. A harness can also cap "Limit concurrent
tasks" independently of its environment (see below).

Codex's models don't produce reasoning summaries by default, so a codex
run's window shows no thinking rows. To get them, add these Default
arguments to the codex harness:

```
-c model_reasoning_summary=auto
```

Optionally add `-c model_reasoning_effort=medium` (or `high`) to raise the
reasoning depth at the same time.

## Models

A harness's Models tab holds the preset list that fills the Model dropdown
on a task's Agent tab. Add/Edit/Remove each entry. Left at its default, a
harness offers the CLI's main models by their unprefixed ids:

- Claude Code: Fable, Opus, Sonnet, Haiku
- Codex: GPT-6-Astra, GPT-5.6-Sol, GPT-5.6-Terra, GPT-5.6-Luna, GPT-5.5
- Custom: no presets

Each entry carries, besides its model id and optional display name:

- **Effort levels** — which of the harness kind's levels this model offers.
  A task on this model only sees these in its Effort dropdown. All levels by
  default.
- **Default effort** — the level a run emits when the task's Effort is
  Default. This keeps runs predictable: the effort comes from these
  settings, never from whatever the CLI on the machine was last set to. New
  entries — and every default-list entry — start at Medium; "CLI default"
  (omit the flag and let the CLI decide) is available as a deliberate
  choice.

A task can still type any other model id as "Custom…" in its Model dropdown.
Such an id has no entry here, so a Default effort can't be resolved for it:
the run omits the effort flag unless the task pins a level itself.

### Updating the model lists

**Update…** under a Claude Code or Codex harness's Models list opens an
Update Models window for that harness; **Advanced → Update Models…** in the
main window opens the same window for every Claude Code and Codex harness at
once. Looper asks each harness for its current models: Codex through
`codex debug models` run in the environment, Claude Code through the
Anthropic models API, signed in with the harness's `ANTHROPIC_API_KEY` if it
sets one, otherwise with the Claude Code login found in that environment.
A harness that can't be reached shows the reason, with Details… for the full
message.

Each harness is a collapsible group listing its current entries and the
models it could add. Every row has an action, Add or Remove, or Do nothing,
and starts on a suggestion: new main models (the newest of each Claude
family, Codex's listed models) are set to Add unless the list already covers
that family, and entries the harness no longer offers are set to Remove.
An id that doesn't look like one of the harness's own models (a proxy's
model, for example) is never suggested for removal.
Notes on each row say "new", "available", "no longer supported", or how
many tasks use it. **Update** applies the actions. Existing entries keep their
names and settings, and added ones start with a Medium default effort.

## Agent settings and MCP servers

**Tools → Agent Settings…** edits Claude Code's and Codex's own settings files
in an environment, as the harness sees them there (a WSL environment's files
are the ones inside the distro). Pick the environment and the Claude Code or
Codex harness at the top; the harness's variables count, so a harness that
sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` edits that folder's files. Pick a
project too and its own files join in. Nothing is written until **Save** or
**Apply**, and then only the files that changed. A file that changed elsewhere
since the window read it (Claude Code saving a "don't ask again" answer, for
example) is replaced only after you agree.

- **Settings** shows each file as text: for Claude Code the user
  `settings.json` and, with a project, its `.claude/settings.json`,
  `.claude/settings.local.json` and `.mcp.json`; for Codex the user
  `config.toml` and the project's `.codex/config.toml`. A file that doesn't
  exist yet is created on save. Save refuses text that isn't valid JSON or
  TOML and names the line.
- **MCP Servers** lists the servers with their scope: for Claude Code, User
  (`~/.claude.json`, every project), Local (`~/.claude.json`, this project,
  only you) and Project (`.mcp.json`, shared with the repository); for Codex,
  User and Project. **Add…**, **Edit…** and **Duplicate** open a server
  window: its name, scope, type (a command it starts, HTTP, or for Claude
  Code SSE), then the command, arguments and environment variables, or the
  URL and headers. Looper changes only the servers' part of `~/.claude.json`,
  which Claude Code keeps its own state in, and only a server's own tables in
  `config.toml`, so the rest of the file and its comments stay as they were.
- **MCP Permissions** lists the servers; **+** asks a server for its tools (a
  command server starts in the environment for that) and lists them under
  it. Each server and tool has a setting: Default, Allow (no asking), Ask
  (every time) or Deny, and Codex also has Ask before changes. For Claude
  Code they're permission rules (`mcp__server__*` for a server,
  `mcp__server__tool` for a tool) in the file **Rules in** picks; the last
  column says what Claude Code does with the rules of every file together,
  where Deny wins over Ask and Ask over Allow. For Codex they're the server's
  own `enabled`, `default_tools_approval_mode`, `disabled_tools` and
  `tools.<tool>.approval_mode` in the file the server is in.

## Limiting concurrent tasks

Both an environment and a harness have a "Limit concurrent tasks" checkbox
(off by default) plus a "Maximum concurrent tasks" count when it's on. A
task counts against its environment's limit — and its chosen harness's — for
its whole cycle: checking, classifying, and running. A task whose
"Simultaneous runs" setting (see [the task editor](tasks.md)) lets it have
several runs in flight at once counts each of those runs separately, so such
a task can take up several slots of the cap by itself.

When a scheduled slot arrives and the environment or harness is already at
its cap, the task simply stays due and is retried on every following tick
until a slot frees up — it isn't skipped. A manual Run Now against a full
cap is rejected instead (logged as skipped) rather than queued.

## Which environment and harness a task uses

A task picks its environment on the editor's **General** tab (a new task
starts on **Settings → General → Default environment**), and one of
that environment's harnesses on the **Agent** tab (blank picks the
environment's first harness). The Agent tab is also where you set the
model, session type (interactive or headless), and — for Claude Code and
Codex — the permission mode; see [the task editor](tasks.md) for the full
field list.

The optional classifier step runs on a Claude Code or Codex harness (a
headless session by default, or an interactive one — its own Session type
field). Left blank, its Harness field on the Classifier tab resolves to the
task's own harness unless that's a Custom one, otherwise the environment's
first Claude Code or Codex harness; you can also pick a specific harness
(and model) there explicitly.

## Default environments

On first launch Looper creates a "Local Shell" environment (id `local`,
set as the default environment) plus the reachable bridge: a "WSL"
environment if the host is Windows, or a "Windows (PowerShell)" environment
if the host is WSL. Each starts with one harness, "Claude Code", running the
`claude` command with no extra arguments.

## Every run is a fresh session by default

No environment or harness setting changes this: every run starts a brand
new agent session, with no memory of previous runs, unless the task's
Agent tab has "Continue one conversation across runs" checked (Claude Code
and Codex only; see [the task editor](tasks.md#agent)). Otherwise, put
anything the agent needs to remember between runs in the project's
`CLAUDE.md`. See [how a run works](how-a-run-works.md) for the full run
lifecycle.
