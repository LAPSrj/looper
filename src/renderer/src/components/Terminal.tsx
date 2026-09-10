import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ActiveRun, TaskRuntime } from '@shared/types';
import { subscribe } from '../events';

interface Props {
  taskId: string;
  runtime: TaskRuntime | undefined;
  /** The run the user picked while several were in flight; null = the newest. */
  selectedRun: string | null;
  onSelectRun: (runId: string | null) => void;
}

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

const RUN_STATE_LABELS: Record<ActiveRun['state'], string> = {
  checking: 'Checking',
  classifying: 'Classifying',
  running: 'Running',
};

function runOptionLabel(run: ActiveRun): string {
  const state = run.held ? 'Needs attention' : RUN_STATE_LABELS[run.state];
  return `Run ${run.runId} · ${state}`;
}

export function Terminal({ taskId, runtime, selectedRun, onSelectRun }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  /** The run whose output is on screen (from the buffer replay or the live stream). */
  const [attachedRun, setAttachedRun] = useState<string | null>(null);

  const runs = runtime?.runs ?? [];
  const runsNewestFirst = useMemo(() => [...runs].sort((a, b) => b.startedAt - a.startedAt), [runs]);

  // What the terminal is attached to. With several runs in flight it is always
  // one specific run — the pick, else the newest — so two streaming sessions
  // can never take turns wiping the screen. With at most one, the terminal
  // simply follows whatever run writes (or shows the last run's output).
  const picked = selectedRun !== null && runs.some((r) => r.runId === selectedRun) ? selectedRun : null;
  const attachTo = picked ?? (runsNewestFirst.length > 1 ? runsNewestFirst[0].runId : null);

  // A pick whose run has finished is stale: back to the newest.
  useEffect(() => {
    if (selectedRun !== null && picked === null) onSelectRun(null);
  }, [selectedRun, picked, onSelectRun]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new XTerm({
      fontFamily: 'Cascadia Mono, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: {
        background: '#0f1115',
        foreground: '#d7dae0',
        cursor: '#d7dae0',
        selectionBackground: '#3a4252',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const pinned = attachTo !== null;
    let loaded = false;
    // Pinned: the run is known up front, even before it has printed anything
    // (still in its check step), so its first bytes are not dropped.
    let currentRun: string | null = attachTo;
    setAttachedRun(currentRun);

    void window.looper.agent.buffer(taskId, attachTo ?? undefined).then((buf) => {
      if (buf) {
        currentRun = buf.runId;
        setAttachedRun(buf.runId);
        term.write(buf.data);
      } else {
        term.write(
          `${DIM}${pinned ? 'No agent session for this run yet.' : 'No agent session for this task yet.'} Output appears here when one starts.${RESET}\r\n`,
        );
      }
      loaded = true;
      window.looper.agent.resize(taskId, term.cols, term.rows, currentRun ?? undefined);
    });

    const unsub = subscribe((e) => {
      if (!loaded) return; // the buffer replay will include it
      if (e.type === 'agent:data' && e.taskId === taskId) {
        if (pinned) {
          if (e.runId !== currentRun) return; // another run's output: not ours
        } else if (currentRun !== e.runId) {
          currentRun = e.runId;
          setAttachedRun(currentRun);
          term.reset();
          term.write(`${DIM}── run ${e.runId} ──${RESET}\r\n`);
          window.looper.agent.resize(taskId, term.cols, term.rows, currentRun);
        }
        term.write(e.data);
      } else if (e.type === 'agent:end' && e.taskId === taskId && e.runId === currentRun) {
        term.write(`\r\n${DIM}── session ended ──${RESET}\r\n`);
      }
    });

    const onData = term.onData((d) => window.looper.agent.write(taskId, d, currentRun ?? undefined));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        window.looper.agent.resize(taskId, term.cols, term.rows, currentRun ?? undefined);
      } catch {
        /* element hidden */
      }
    });
    ro.observe(el);
    term.focus();

    return () => {
      unsub();
      onData.dispose();
      ro.disconnect();
      term.dispose();
    };
  }, [taskId, attachTo]);

  const attachedActiveRun = runs.find((r) => r.runId === attachedRun);
  const held = attachedActiveRun ? attachedActiveRun.held : !!runtime?.held;

  return (
    <div className="terminal-wrap">
      {runsNewestFirst.length > 1 && (
        <select className="terminal-runs" value={attachTo ?? ''} onChange={(e) => onSelectRun(e.target.value)}>
          {runsNewestFirst.map((r) => (
            <option key={r.runId} value={r.runId}>
              {runOptionLabel(r)}
            </option>
          ))}
        </select>
      )}
      {held && (
        <div className="banner warn">
          The agent finished a turn without calling <code>looper-done</code> and this task is set to hold. Type into the
          terminal to continue it, or press <b>Stop agent</b>.
        </div>
      )}
      <div className="terminal" ref={ref} />
    </div>
  );
}
