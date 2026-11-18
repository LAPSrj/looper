import { useState } from 'react';
import { terminalOverlay } from '../phone-lists';
import { isPhone } from '../web/page-nav';
import { TERMINAL_STAGE, TerminalOverlay } from './phone/TerminalOverlay';
import { useXterm } from './xterm';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const ENDED = `\r\n${DIM}── session ended ──${RESET}\r\n`;
/** Quitting Looper stopped the harness: the next key starts it again on the conversation (the key itself isn't sent). */
const STOPPED = `\r\n${DIM}── stopped when Looper quit · press any key to go on ──${RESET}\r\n`;

/** A terminal session: its output so far, then live, with keys, files and size passed to it. */
export function TerminalView({ id }: { id: string }) {
  const [output, setOutput] = useState<'unknown' | 'none' | 'some'>('unknown');
  const session = window.looper.terminalSession;
  const { ref, keys } = useXterm(id, {
    replay: (term) => {
      setOutput('unknown');
      return session.output(id).then((out) => {
        if (out?.data) term.write(out.data);
        if (out?.stopped) term.write(out.note ? `\r\n${DIM}── ${out.note} ──${RESET}\r\n` : STOPPED);
        else if (!out || out.ended) term.write(ENDED);
        // An ended or stopped session has nothing more to wait for.
        setOutput(out?.data || !out || out.ended || out.stopped ? 'some' : 'none');
      });
    },
    live: (e, term) => {
      if (e.type === 'terminal:data' && e.id === id) {
        term.write(e.data);
        setOutput('some');
      } else if (e.type === 'terminal:end' && e.id === id) {
        term.write(ENDED);
        setOutput('some');
      }
    },
    write: (d) => session.write(id, d),
    resize: (cols, rows) => session.resize(id, cols, rows),
    attachFiles: (files) => session.attachFiles(id, files),
    showMenu: (hasSelection) => session.showContextMenu(id, hasSelection),
  });
  // A phone shows "Starting…" over the terminal until its session prints something.
  const overlay = isPhone && terminalOverlay({ loaded: output !== 'unknown', hasOutput: output === 'some' }) !== null;
  return (
    <div className="terminal-session">
      <div className="terminal-stage" style={TERMINAL_STAGE}>
        <div className="terminal" ref={ref} />
        {overlay && <TerminalOverlay />}
      </div>
      {keys}
    </div>
  );
}
