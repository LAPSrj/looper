import { useEffect, useMemo, useRef, useState } from 'react';
import { inChatGroup, sessionGroupKey, type ChatPlaces, type SessionSummary } from '@shared/sessions';
import { useLiveState, useSessionsState } from './live-state';
import { EmptyState } from './components/EmptyState';
import { sendsOnEnterHere } from './components/MessageBox';
import { NO_CHATS } from './components/SessionList';
import { CheckboxField, FormGroup, TextArea } from './components/ui';
import { WindowActions } from './components/WindowActions';

/**
 * The chats and terminal sessions a message can go to: open ones, and no task
 * runs. A terminal that quitting stopped has no harness to type it into until
 * a key in it starts one again.
 */
const sendable = (sessions: SessionSummary[]) => sessions.filter((x) => x.status !== 'ended' && x.kind !== 'run' && !x.stopped);

/** The ids of the sessions in a list group (ChatGroup.key). */
const idsIn = (sessions: SessionSummary[], group: string, places: ChatPlaces) => new Set(sessions.filter((s) => inChatGroup(s, group, places)).map((s) => s.id));

/**
 * Send to Chats: one message to the chats picked here. A chat that's
 * working gets it in its queue; a terminal session gets it typed in, then Enter.
 * `group` (a list group's right-click menu): its chats start checked.
 */
export function SendToSessionsApp({ group }: { group?: string }) {
  const all = useSessionsState();
  const sessions = useMemo(() => (all ? sendable(all.sessions) : []), [all]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const shown = useRef(sessions);
  shown.current = sessions;
  // A Projects tab folder's group needs its projects' folders.
  const { projects, projectFolders } = useLiveState();
  const places = useRef<ChatPlaces>({ projects, folders: projectFolders, layout: {} });
  places.current = { projects, folders: projectFolders, layout: {} };
  // Once the user ticks or unticks a chat, or a pick arrives, the group's start no longer applies: a projects event must not tick again what was unticked.
  const decided = useRef(false);

  useEffect(() => {
    document.title = 'Send to Chats';
    return window.looper.onUi((e) => {
      if (e.type === 'send-to-sessions-pick') {
        decided.current = true;
        setPicked(idsIn(shown.current, e.group, places.current));
      }
    });
  }, []);
  // The group's chats start checked once the list is in.
  const loaded = all !== null;
  useEffect(() => {
    if (loaded && group !== undefined && !decided.current) setPicked(idsIn(shown.current, group, places.current));
  }, [loaded, group, projects, projectFolders]);
  // A session that closed can't be sent to.
  useEffect(() => {
    setPicked((p) => {
      const open = [...p].filter((id) => sessions.some((s) => s.id === id));
      return open.length === p.size ? p : new Set(open);
    });
  }, [sessions]);

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
  const setAll = (ids: string[], on: boolean) => {
    decided.current = true;
    setPicked((p) => {
      const next = new Set(p);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };
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
        {sessions.length === 0 && <EmptyState>{NO_CHATS}</EmptyState>}
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
      <WindowActions draft={text} confirm={{ label: 'Send', run: send, disabled: !text.trim() || picked.size === 0 }} />
    </div>
  );
}
