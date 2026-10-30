import { useEffect, useState } from 'react';
import type { SessionSummary } from '@shared/sessions';
import { subscribe } from './events';
import { useDialogKeys } from './components/hooks';
import { EditorFooter } from './components/ui';

/**
 * Send to Sessions: one message to the sessions picked here. A chat that's
 * working gets it in its queue; a terminal session gets it typed in, then Enter.
 */
export function SendToSessionsApp() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');

  useEffect(() => {
    document.title = 'Send to Sessions';
    void window.looper.sessions.state().then((s) => setSessions(s.sessions.filter((x) => x.status !== 'ended')));
    return subscribe((e) => {
      if (e.type !== 'sessions') return;
      const open = e.state.sessions.filter((x) => x.status !== 'ended');
      setSessions(open);
      // A session that closed can't be sent to.
      setPicked((p) => new Set([...p].filter((id) => open.some((s) => s.id === id))));
    });
  }, []);

  const groups: { name: string; items: SessionSummary[] }[] = [];
  for (const s of sessions) {
    const last = groups[groups.length - 1];
    if (last?.name === s.groupName) last.items.push(s);
    else groups.push({ name: s.groupName, items: [s] });
  }
  const harnesses = [...new Set(sessions.map((s) => s.harnessName))];
  const setAll = (ids: string[], on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const allOf = (items: SessionSummary[]) => items.length > 0 && items.every((s) => picked.has(s.id));
  /** A check box for a set of sessions: checked when all are picked, partly checked when some are. */
  const groupBox = (items: SessionSummary[]) => (
    <input
      type="checkbox"
      checked={allOf(items)}
      ref={(el) => {
        if (el) el.indeterminate = !allOf(items) && items.some((s) => picked.has(s.id));
      }}
      onChange={(e) => setAll(items.map((s) => s.id), e.target.checked)}
    />
  );

  const send = () => {
    if (!text.trim() || picked.size === 0) return;
    window.looper.sessions.send([...picked], text);
    window.close();
  };
  useDialogKeys({ onSave: send, onCancel: () => window.close() });

  return (
    <div className="editor send-sessions">
      <div className="send-sessions-pick">
        <label className="checkbox-field">
          {groupBox(sessions)}
          Every session
        </label>
        {harnesses.length > 1 &&
          harnesses.map((h) => {
            const items = sessions.filter((s) => s.harnessName === h);
            return (
              <label key={h} className="checkbox-field">
                {groupBox(items)}
                Every {h} session
              </label>
            );
          })}
      </div>
      <div className="send-sessions-list">
        {groups.map((g) => (
          <div key={g.name}>
            <label className="checkbox-field send-sessions-group">
              {groupBox(g.items)}
              {g.name}
            </label>
            {g.items.map((s) => (
              <label key={s.id} className="checkbox-field send-sessions-item">
                <input type="checkbox" checked={picked.has(s.id)} onChange={(e) => setAll([s.id], e.target.checked)} />
                <span className="send-sessions-title">{s.title}</span>
                <span className="muted send-sessions-kind">
                  {s.harnessName}
                  {s.kind === 'terminal' ? ' · Terminal' : ''}
                </span>
              </label>
            ))}
          </div>
        ))}
        {sessions.length === 0 && <div className="empty">No sessions are open.</div>}
      </div>
      <textarea className="send-sessions-text" value={text} placeholder="Message" rows={6} autoFocus onChange={(e) => setText(e.target.value)} />
      <EditorFooter primaryLabel="Send" onPrimary={send} onCancel={() => window.close()} primaryDisabled={!text.trim() || picked.size === 0} />
    </div>
  );
}
