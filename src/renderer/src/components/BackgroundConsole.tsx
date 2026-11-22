import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { mergeOutput, type OutputShown } from '@shared/output-tail';
import type { BackgroundTask } from '@shared/sessions';
import { stripAnsi } from '../format';
import { atEnd, useNewestFirst, useStayAtEnd } from './newest-first';

/** How often a running command's output is asked for; an unchanged file answers with nothing. */
const POLL_MS = 2000;
/** Lines drawn as one element: the console draws its newest blocks first, as a conversation draws its messages. */
const BLOCK_LINES = 25;

/**
 * A background command's output as it grows: the first read takes its tail, and each poll after only what the
 * command added since (`known`). 'gone' when it can't be read.
 */
function useBackgroundOutput(sessionId: string, b: BackgroundTask): OutputShown | null | 'gone' {
  const key = `${sessionId}\0${b.id}`;
  const [shown, setShown] = useState<{
    key: string;
    out: OutputShown | 'gone';
  } | null>(null);
  // What was read so far for this command, kept across its status changing (a last read once it ends).
  const kept = useRef<{ key: string; out: OutputShown | null }>({
    key,
    out: null,
  });
  if (kept.current.key !== key) kept.current = { key, out: null };
  const running = b.status === 'running';
  useEffect(() => {
    if (!b.outputFile) return;
    let live = true;
    let busy = false;
    const load = () => {
      if (busy || (running && document.visibilityState === 'hidden')) return;
      busy = true;
      const before = kept.current.out;
      void window.looper.sessions.backgroundOutput(sessionId, b.id, before?.end).then(
        (r) => {
          busy = false;
          if (!live) return;
          if (!r) {
            if (!before) setShown({ key, out: 'gone' });
            return;
          }
          const next = mergeOutput(before, r);
          if (next === before) return;
          kept.current = { key, out: next };
          setShown({ key, out: next });
        },
        () => {
          busy = false;
          if (live && !before) setShown({ key, out: 'gone' });
        },
      );
    };
    load();
    const timer = running ? setInterval(load, POLL_MS) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [key, running, b.outputFile, sessionId, b.id]);
  return shown && shown.key === key ? shown.out : null;
}

/** Output's lines in blocks of BLOCK_LINES, each block's text one string, so an unchanged block stays the same. */
function outputBlocks(text: string): string[] {
  const lines = stripAnsi(text).replace(/\n+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += BLOCK_LINES) blocks.push(lines.slice(i, i + BLOCK_LINES).join('\n'));
  return blocks;
}

/**
 * The selected background task as a console, as Now shows a command: its title and state, then the command at
 * the prompt and its output as it comes, with a cursor while it runs and Claude's summary once it ends. Only the
 * newest output is drawn at first; older lines are drawn as the reader scrolls up to them.
 */
export function BackgroundConsole({ b, sessionId, status }: { b: BackgroundTask; sessionId: string; status: ReactNode }) {
  const out = useBackgroundOutput(sessionId, b);
  const text = out && out !== 'gone' ? out.text : '';
  const blocks = useMemo(() => outputBlocks(text), [text]);
  const ref = useRef<HTMLDivElement>(null);
  const stays = useRef(true);
  const running = b.status === 'running';
  const { hidden, onScroll } = useNewestFirst(ref, `${sessionId}/${b.id}`, blocks.length, false);
  useStayAtEnd(ref, stays, `${text.length}/${b.status}`);
  return (
    <div className="now-screen bg-screen">
      <div className="now-title">
        <span className="now-tool bg-screen-label">{b.label}</span>
        <span className={`bg-screen-status${b.status === 'failed' ? ' error-text' : ' muted'}`}>{status}</span>
      </div>
      <div
        ref={ref}
        className="now-terminal bg-console"
        role="log"
        aria-label={`Output of ${b.label}`}
        tabIndex={0}
        onScroll={(e) => {
          stays.current = atEnd(e.currentTarget);
          onScroll(e.currentTarget);
        }}
      >
        {b.command && (
          <div>
            <span className="now-term-prompt">$ </span>
            {b.command}
          </div>
        )}
        {out !== 'gone' && out?.cut && hidden === 0 && <div className="now-term-comment">Earlier output isn’t shown.</div>}
        {blocks.slice(hidden).map((t, n) => (
          <div key={hidden + n}>{t}</div>
        ))}
        {out === 'gone' && <div className="now-term-comment">The output can’t be read.</div>}
        {running ? (
          <span className="now-term-cursor" />
        ) : (
          <>
            {b.summary && <div className="now-term-comment">{b.summary}</div>}
            {b.outputFile && (
              <div>
                <span className="now-term-prompt">$ </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
