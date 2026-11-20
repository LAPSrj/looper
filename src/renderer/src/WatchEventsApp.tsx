import { useEffect, useState } from 'react';
import { EmptyWindow, Field, FormGroup, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { SESSIONS, useLiveItem, useSave } from './components/hooks';

/**
 * Chat → Watch Task Events on a task: the event id whose trigger events the
 * chat's agent gets (the events' looper_related_id), or empty for all of them.
 */
export function WatchEventsApp({ chatId, taskId }: { chatId: string; taskId: string }) {
  const [eventId, setEventId] = useState('');
  const [task, setTask] = useState<string | null>(null);
  const { missing } = useLiveItem(SESSIONS, chatId);
  const saver = useSave();

  useEffect(() => {
    document.title = 'Watch Task Events';
    let live = true;
    void window.looper.chat.get(chatId).then((c) => live && setTask(c?.watchTasks?.find((t) => t.id === taskId)?.name ?? null));
    return () => {
      live = false;
    };
  }, [chatId, taskId]);

  if (missing) return <EmptyWindow gone="This chat is closed." />;

  const watch = () => saver.save(async () => window.looper.chat.setWatch(chatId, taskId, eventId.trim(), true));

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label="Task">
              <TextInput readOnly value={task ?? ''} />
            </Field>
            <Field label="Event ID">
              <TextInput autoFocus verbatim value={eventId} placeholder="All events" onChange={(e) => setEventId(e.target.value)} />
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Watch', run: watch }} busy={saver.busy} />
    </div>
  );
}
