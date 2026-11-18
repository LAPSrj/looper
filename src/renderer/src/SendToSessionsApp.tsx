import { useEffect, useRef, useState } from 'react';
import { sessionGroupKey, type SessionSummary } from '@shared/sessions';
import { subscribe } from './events';
import { sendsOnEnterHere } from './components/MessageBox';
import { CheckboxField, FormGroup, TextArea } from './components/ui';
import { WindowActions } from './components/WindowActions';

/**
 * The chats and terminal sessions a message can go to: open ones, and no task
 * runs. A terminal that quitting stopped has no harness to type it into until
 * a key in it starts one again.
 */
const sendable = (sessions: SessionSummary[]) => sessions.filter((x) => x.status !== 'ended' && x.kind !== 'run' && !x.stopped);

/** The ids of the sessions in a list group (sessionGroupKey). */
const idsIn = (sessions: SessionSummary[], group: string) => new Set(sessions.filter((s) => sessionGroupKey(s) === group).map((s) => s.id));

/**
 * Send to Chats: one message to the chats picked here. A chat that's
 * working gets it in its queue; a terminal session gets it typed in, then Enter.
 * `group` (a list group's right-click menu): its chats start checked.
 */
export function SendToSessionsApp({ group }: { group?: string }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const shown = useRef(sessions);
  shown.current = sessions;

  useEffect(() => {
    document.title = 'Send to Chats';
    void window.looper.sessions.state().then((s) => {
      const open = sendable(s.sessions);
      setSessions(open);
      if (group !== undefined) setPicked(idsIn(open, group));
    });
    const offUi = window.looper.onUi((e) => {
      if (e.type === 'send-to-sessions-pick') setPicked(idsIn(shown.current, e.group));
    });
    const offEvents = subscribe((e) => {
      if (e.type !== 'sessions') return;
      const open = sendable(e.state.sessions);
      setSessions(open);
      // A session that closed can't be sent to.
      setPicked((p) => new Set([...p].filter((id) => open.some((s) => s.id === id))));
    });
    return () => {
      offUi();
      offEvents();
    };
  }, [group]);

  // By the Chats list's groups: two projects of the same name are two groups.
  const byKey = new Map<string, { key: string; name: string; items: SessionSummary[] }>();
  for (const s of sessions) {
    const key = sessionGroupKey(s);
    const group = byKey.get(key);
    if (group) group.items.push(s);
    else byKey.set(key, { key, name: s.groupName, items: [s] });
  }
  const groups = [...byKey.values()];
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
  const groupBox = (label: string, items: SessionSummary[], className?: string) => (
    <CheckboxField
      key={label}
      label={label}
      className={className}
      checked={allOf(items)}
      indeterminate={!allOf(items) && items.some((s) => picked.has(s.id))}
      onChange={(on) => setAll(items.map((s) => s.id), on)}
    />
  );

  const send = () => {
    if (!text.trim() || picked.size === 0) return;
    window.looper.sessions.send([...picked], text);
    window.close();
  };

  return (
    <div className="editor send-sessions">
      <div className="send-sessions-pick">
        <FormGroup>
          {groupBox('Every chat', sessions)}
          {harnesses.length > 1 &&
            harnesses.map((h) =>
              groupBox(
                `Every ${h} chat`,
                sessions.filter((s) => s.harnessName === h),
              ),
            )}
        </FormGroup>
      </div>
      <div className="send-sessions-list">
        {groups.map((g) => (
          <FormGroup key={g.key}>
            {groupBox(g.name, g.items, 'send-sessions-group')}
            {g.items.map((s) => (
              <CheckboxField
                key={s.id}
                className="send-sessions-item"
                checked={picked.has(s.id)}
                onChange={(on) => setAll([s.id], on)}
                label={
                  <span className="send-sessions-label">
                    <span className="send-sessions-title">{s.title}</span>
                    <span className="muted send-sessions-kind">
                      {s.harnessName}
                      {s.kind === 'terminal' ? ' · Terminal' : ''}
                    </span>
                  </span>
                }
              />
            ))}
          </FormGroup>
        ))}
        {sessions.length === 0 && <div className="empty">No chats are open.</div>}
      </div>
      <TextArea
        className="send-sessions-text"
        value={text}
        placeholder="Message"
        rows={6}
        autoFocus
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // As in a chat's message box: Enter sends on the desktop (Shift+Enter breaks the line), a phone's Enter breaks it.
          if (sendsOnEnterHere(e)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <WindowActions confirm={{ label: 'Send', run: send, disabled: !text.trim() || picked.size === 0 }} />
    </div>
  );
}
