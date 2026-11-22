import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { mergeOutput, type OutputShown } from '@shared/output-tail';
import type { BackgroundTask } from '@shared/sessions';
import { WORKFLOW_STATUS_TEXT } from '@shared/workflows';
import { stripAnsi } from '../format';
import { DetailInBar } from './ListDetail';
import { useWaitedText } from './Live';
import { NavBar } from './NavBar';
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

/** A background command's or workflow's state: "Running for 3 min" counts whole minutes, from a minute on. */
export function useBackgroundStatus(b: BackgroundTask): string {
  const started = b.startedAt ? Date.parse(b.startedAt) : NaN;
  return useWaitedText(b.status === 'running' && !Number.isNaN(started) ? started : null, WORKFLOW_STATUS_TEXT[b.status]);
}

/**
 * The selected background task as a console, as Now shows a command: its title and state, then the command at
 * the prompt and its output as it comes, with a cursor while it runs and Claude's summary once it ends. Only the
 * newest output is drawn at first; older lines are drawn as the reader scrolls up to them. Pushed on a phone, its
 * title is the bar's (ListDetail's detailTitle) and its state the line under it, so it has no title row of its own.
 */
export function BackgroundConsole({ b, sessionId }: { b: BackgroundTask; sessionId: string }) {
  const status = useBackgroundStatus(b);
  const inBar = useContext(DetailInBar);
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
      {inBar ? (
        <NavBar subtitle={status} order={30} />
      ) : (
        <div className="now-title">
          <span className="now-tool bg-screen-label">{b.label}</span>
          <span className={`bg-screen-status${b.status === 'failed' ? ' error-text' : ' muted'}`}>{status}</span>
        </div>
      )}
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
