import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { TaskRuntime } from '@shared/types';
import { subscribe } from '../events';

interface Props {
  taskId: string;
  running: boolean;
  runtime: TaskRuntime | undefined;
}

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

export function Terminal({ taskId, running, runtime }: Props) {
  const ref = useRef<HTMLDivElement>(null);

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

    let loaded = false;
    let currentRun: string | null = null;
    void window.looper.agent.buffer(taskId).then((buf) => {
      if (buf) {
        currentRun = buf.runId;
        term.write(buf.data);
      } else {
        term.write(`${DIM}No agent session for this task yet. Output appears here when one starts.${RESET}\r\n`);
      }
      loaded = true;
      window.looper.agent.resize(taskId, term.cols, term.rows);
    });

    const unsub = subscribe((e) => {
      if (!loaded) return; // the buffer replay will include it
      if (e.type === 'agent:data' && e.taskId === taskId) {
        if (currentRun !== e.runId) {
          currentRun = e.runId;
          term.reset();
          term.write(`${DIM}── run ${e.runId} ──${RESET}\r\n`);
          window.looper.agent.resize(taskId, term.cols, term.rows);
        }
        term.write(e.data);
      } else if (e.type === 'agent:end' && e.taskId === taskId) {
        term.write(`\r\n${DIM}── session ended ──${RESET}\r\n`);
      }
    });

    const onData = term.onData((d) => window.looper.agent.write(taskId, d));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        window.looper.agent.resize(taskId, term.cols, term.rows);
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
  }, [taskId]);

  return (
    <div className="terminal-wrap">
      {runtime?.held && (
        <div className="banner warn">
          The agent finished a turn without calling <code>looper-done</code> and this task is set to hold. Type into the
          terminal to continue it, or press <b>Stop agent</b>.
        </div>
      )}
      {!running && <div className="banner muted">No agent running. Showing the last session's output.</div>}
      <div className="terminal" ref={ref} />
    </div>
  );
}
