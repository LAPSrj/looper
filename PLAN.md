# Looper — plan

Cron-style manager for AI agent loops. Instead of an agent burning tokens
polling for work, a cheap script (and optionally a cheap classifier model)
polls; a fresh `claude` session is started only when there is something to do,
runs in a visible terminal, signals when done, and the loop resumes. At most
one agent per task, ever.

## 1. Architecture

Electron app, three layers. The engine has **no Electron imports** so it can be
moved to a standalone daemon later without a rewrite.

```
looper/
  src/
    engine/                # pure Node — scheduler + runners + store
      scheduler.ts         # timers, per-task state machine, skip/overlap logic
      target/
        index.ts           # Target interface: buildCommand(), kill(), pathFor()
        wsl.ts             # host=windows|wsl -> target=wsl
        windows.ts         # host=windows|wsl -> target=windows
      steps/
        check.ts           # runs check script, parses contract
        classify.ts        # claude -p --model <cheap> --json-schema ...
        agent.ts           # pty session lifecycle, signals, timeouts, kill
      signals.ts           # done/idle file watchers (per run dir)
      inbox.ts             # task registration from agents (watched dir)
      store/
        tasks.ts           # tasks.json (zod-validated)
        runs.ts            # <task>/runs.jsonl + per-run dirs
      types.ts
    main/                  # electron main: window, IPC, hosts the engine (v1)
    preload/
    renderer/              # React + xterm.js
    cli/                   # `looper` CLI: add | list | run | done | pause
  PLAN.md
```

Data dir (Windows host): `%APPDATA%\looper\`
```
tasks.json
inbox/                     # task registrations dropped by agents
tasks/<taskId>/
  runs.jsonl               # one record per phase per cycle
  runs/<runId>/
    run.sh | run.cmd       # generated launcher (kept for debugging)
    prompt.txt
    context.json           # check-script output
    output.log             # raw pty capture
    idle                   # touched by Stop hook after each agent turn
    done                   # touched by agent when finished
```

From WSL this dir is reachable as `/mnt/c/Users/<u>/AppData/Roaming/looper/`
— that is what makes file-based signalling work across the boundary with zero
networking.

## 2. Task model

```ts
type Task = {
  id: string; name: string; enabled: boolean;
  schedule: { every: string } | { cron: string };   // "5m" | "*/10 * * * *"
  target: { kind: "wsl"; distro?: string; shell?: string }   // shell default "bash -lic"
        | { kind: "windows"; shell?: "powershell" | "cmd" };
  cwd: string;                     // native to the target ("/home/…" or "C:\…")
  check: { command: string; timeoutSec: number };            // default 60
  classifier?: {
    model: string;                 // e.g. "haiku"
    prompt: string;                // receives {{summary}} {{context}}
    timeoutSec: number;
  };
  agent: {
    model: string;
    prompt: string;                // template: {{summary}} {{context}} {{task}}
    extraArgs: string[];           // appended verbatim to `claude …`
    mode: "interactive" | "headless";   // pty session vs `claude -p`
    maxRuntimeMin: number;         // hard kill
    idleGraceMin: number;          // after Stop-hook idle with no `done`
    onIdleTimeout: "finish" | "hold";   // hold = leave running, flag in UI
  };
  backoff: { maxConsecutiveErrors: number };   // auto-pause + alert
};
```

## 3. Per-task state machine

```
IDLE ──timer──▶ CHECKING ──act=false──▶ IDLE
CHECKING ──act=true, no classifier──▶ RUNNING
CHECKING ──act=true, classifier──▶ CLASSIFYING ──no──▶ IDLE
CLASSIFYING ──yes──▶ RUNNING
RUNNING ──done | pty exit | idle grace | max runtime──▶ IDLE
any ──error──▶ IDLE (logged; consecutive errors ≥ N → PAUSED + alert)
```

- Timer fires only in IDLE. If a tick arrives in any other state it is
  **logged as "skipped: <state>"** and dropped. One agent per task by
  construction — no locks needed.
- `every` intervals count from the **end** of the previous cycle (no pile-up).
  `cron` is wall-clock; a cron tick during RUNNING is skipped, same rule.
- Manual actions: run now, pause/resume, stop agent, edit.
- On startup, runs left in RUNNING are marked `interrupted` and the task goes
  IDLE.

## 4. Target abstraction (Windows ⇄ WSL)

Every run gets a **generated launcher script** in its run dir instead of a
quoted-in-place command line. Kills three problems at once: shell quoting of
prompts, env injection, and a debuggable artefact.

| host    | target  | spawn                                                      |
|---------|---------|------------------------------------------------------------|
| windows | wsl     | `wsl.exe -d <distro> -- bash -lic /mnt/c/…/runs/<id>/run.sh` |
| windows | windows | `powershell.exe -File …\run.ps1` (or `cmd /c run.cmd`)     |
| wsl     | wsl     | `bash -lic …/run.sh`                                        |
| wsl     | windows | `powershell.exe -File $(wslpath -w …)/run.ps1` (interop)    |

`run.sh` does: `cd $cwd`, exports `LOOPER_TASK LOOPER_RUN LOOPER_RUN_DIR
LOOPER_DONE_FILE LOOPER_IDLE_FILE`, then `exec claude …`. `-lic` (login +
interactive) so nvm-installed `claude` is on PATH; overridable per task via
`target.shell`.

Looper never translates task paths; `cwd` is written in the target's native
form. The only translated path is the run dir (Windows → `/mnt/c/...`), a
fixed prefix swap.

## 5. Check-script contract

Last line of stdout is JSON:

```json
{"act": true, "summary": "3 unread issues", "context": {"ids": [12, 15, 19]}}
```

- exit 0 + `act:false` → nothing to do
- exit 0 + `act:true`  → proceed (classifier or agent); `summary`/`context`
  are threaded into both prompts via `{{summary}}` / `{{context}}`
- exit ≠ 0, timeout, or unparseable stdout → **error**, not a trigger

Chosen over "exit 0 = act" because a script that crashes with exit 1 would
silently read as "nothing to do". JSON also carries context downstream so the
agent starts with the facts instead of re-discovering them.

## 6. Classifier step

```
claude -p --model <classifier.model> --output-format json \
       --json-schema '{"type":"object","properties":{"act":{"type":"boolean"},"reason":{"type":"string"}},"required":["act","reason"]}' \
       --max-budget-usd 0.05 "<rendered classifier prompt>"
```
Context goes on stdin. Runs through the same target abstraction (so it uses
the WSL `claude` auth). Result + reason logged. Direct Anthropic API call is
a later optimisation if an API key is available (skips CLI startup).

## 7. Agent session

**interactive (default)** — `node-pty` spawns the launcher; renderer shows it
in xterm.js; the user can type into it. **headless** — same launcher but
`claude -p … --output-format stream-json`; exit == done. Headless needs an
explicit `--permission-mode` in `extraArgs`.

End-of-run signals, any one ends the run (first wins):

1. **done file** — prompt footer (via `--append-system-prompt`) tells the agent
   to run `looper-done` (a one-liner shell function defined in `run.sh` that
   writes `$LOOPER_DONE_FILE`) as its last action. Explicit, what you
   described.
2. **idle grace** — looper injects a `Stop` hook via
   `--settings '<json>'` that touches `$LOOPER_IDLE_FILE`; if idle persists
   `idleGraceMin` without `done`, the run ends (or is held + flagged, per
   `onIdleTimeout`). Catches agents that forget to signal, or sit on a
   permission prompt / question. *(`--settings` hooks merging with user
   settings: verify in spike.)*
3. **pty exit** — user typed `/exit`, or claude crashed.
4. **max runtime** — hard cap.

Termination: on Windows `taskkill /PID <wsl.exe> /T /F`, then verify with
`wsl.exe -d X -- pgrep -f LOOPER_RUN=<id>`; fallback `pkill -f` on the same
marker. The run id is on the command line precisely so it can be found.

Each run is a **fresh session** — that is the point: no context accumulation,
no compaction. Continuity between runs lives in CLAUDE.md / memory, not in
the conversation.

## 8. Run log + terminal UI

- `runs.jsonl` record: `{ts, runId, phase: check|classify|agent|skip, result,
  exitCode, durationMs, summary, error, stdoutTail}`.
- Raw pty output captured to `output.log` (ANSI kept; stripped copy on demand).
- UI: left = task list with state badge + next-run countdown; right = tabs
  per task: **Log** (table of runs, filter by phase/result) and **Terminal**
  (xterm.js; `@xterm/addon-serialize` keeps scrollback when switching tabs).
  Toolbar: run now, pause, stop agent, edit, open run dir.

## 9. Crash resilience

- Engine loop tick is `try/catch` per task; a throwing task never affects
  others.
- Every `spawn` has `error`/`exit` handlers and a timeout that kills the tree.
- `process.on('uncaughtException'/'unhandledRejection')` in main → log +
  continue (never exit).
- State persisted after each transition; startup reconciles.
- Renderer crash → `webContents` reload; engine unaffected (separate process
  by Electron design).
- Per-task backoff: N consecutive errors → PAUSED + toast/notification.
- Single-instance lock (`app.requestSingleInstanceLock`).
- Later: engine as a daemon + Windows autostart, so a UI crash/close does not
  stop loops at all.

## 10. Registration by agents

`looper` CLI (Node, thin). `looper add task.json` validates and drops it into
`inbox/`; the engine watches the dir, merges into `tasks.json`, moves file to
`inbox/done/` or `inbox/rejected/<reason>`. Works from WSL because the inbox
is under `/mnt/c/...`. `looper list|run|pause|done` follow the same pattern.
Later: localhost HTTP API (mirrored networking or host-IP) for live
responses.

## 11. Stack

- electron-vite, TypeScript, React, zod (schemas), croner (cron parsing)
- `node-pty` (+ `@electron/rebuild`), `@xterm/xterm`, `@xterm/addon-fit`,
  `@xterm/addon-serialize`
- Storage: JSON + JSONL files (no second native module). SQLite only if the
  run log outgrows it.
- electron-builder for packaging (Windows NSIS/portable).

## 12. Milestones

0. **Spike (do first — highest risk):** Electron + node-pty spawning
   `wsl.exe -d Ubuntu -- bash -lic claude` rendered in xterm.js; type into it;
   kill it cleanly; confirm `--settings` Stop hook fires and touches a file
   under `/mnt/c`.
1. **Engine + CLI, headless:** task schema, store, scheduler, check step,
   runs.jsonl. Driven by `looper` CLI, no UI. Unit tests for the state machine.
2. **Agent runs:** launcher generation, pty session, four end signals, kill
   path, interrupted-run reconciliation.
3. **UI:** task list, log table, terminal tabs, toolbar actions, task editor.
4. **Classifier step.**
5. **Registration inbox, packaging, autostart, notifications, run-dir
   retention/cleanup.**

## 13. Status (2026-08-30)

Milestones 0–5 built in one pass; see README for usage. Verified live in WSL
(host=wsl → target=wsl): check contract incl. error path, headless agent,
interactive agent with `looper-done`, trust-dialog auto-answer, prompt-wait
detection, clean shutdown killing a live agent, inbox registration via the CLI,
Electron main boot under WSLg. Unit tests cover duration/template/check
parsing/classifier parsing/targets/scheduler state machine/prompt detection.

Not yet verified: Windows host (node-pty ConPTY + `wsl.exe` spawn), the
`windows` PowerShell target, WSL-host → Windows-target, the classifier step
end to end (its output parsing is tested against a real `claude -p` envelope).

Findings that changed the design during the build:
- Interactive claude blocks on a "trust this folder?" dialog → answered
  automatically (`autoTrustWorkspace`).
- Permission prompts do not fire the Stop hook → the pty stream is also fed
  into a headless xterm (`@xterm/headless`); a visible "Esc to cancel" footer
  starts the idle clock, and it clears when the footer leaves the screen. A
  byte-stream heuristic was tried first and failed: claude partially redraws
  the screen while a prompt waits.
- `looper-done` is itself a Bash call → pre-allowed through the injected
  `--settings` (`permissions.allow`), verified with `claude -p`.
- `bash -lic` without a pty prints job-control noise → filtered from stderr.
- Nested-session env markers (`CLAUDECODE`, …) are stripped from child envs.

## 14. Risks / open points

- node-pty native build under Electron on Windows (ConPTY) — spike.
- Killing the WSL side of a run reliably — marker + pkill fallback.
- `bash -lic` vs how `claude` is installed (nvm/npm global/native) — per-task
  shell override exists.
- Claude permission prompts blocking an interactive agent — idle grace covers
  it; users can pass `--permission-mode` in `extraArgs`.
- `--settings` hook merge semantics — verify in spike (unverified).
- `/mnt/c` I/O is slow but signal files are tiny; fine.
- Decisions taken without asking (change if you disagree): React; JSON files
  over SQLite; file signals over HTTP; JSON check contract over exit codes;
  engine inside Electron main for v1.
