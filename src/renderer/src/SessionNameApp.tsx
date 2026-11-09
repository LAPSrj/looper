import { useEffect, useState } from 'react';
import { EmptyWindow, Field, FormGroup, TextInput } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { subscribe } from './events';

/**
 * Rename… on a chat or terminal session: its name, shown in the Chats list,
 * its window's title, the dashboard and History. An empty name goes back to
 * the automatic one.
 */
export function SessionNameApp({ sessionId }: { sessionId: string }) {
  const [name, setName] = useState('');
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    document.title = 'Rename';
    void window.looper.sessions.state().then((st) => {
      const s = st.sessions.find((x) => x.id === sessionId);
      if (!s) {
        setMissing(true);
        return;
      }
      setName(s.title);
      setLoaded(true);
    });
    // Keep the draft; only track the session itself (closed).
    return subscribe((e) => {
      if (e.type === 'sessions' && !e.state.sessions.some((x) => x.id === sessionId)) setMissing(true);
    });
  }, [sessionId]);

  const save = async () => {
    setSaving(true);
    try {
      await window.looper.sessions.rename(sessionId, name);
      window.close();
    } catch (e) {
      void window.looper.showError((e as Error).message);
      setSaving(false);
    }
  };

  if (missing) return <EmptyWindow gone="This conversation is closed." />;

  return (
    <div className="editor">
      <div className="editor-body">
        <div className="form">
          <FormGroup>
            <Field label="Name">
              <TextInput selectWhen={loaded} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </FormGroup>
        </div>
      </div>
      <WindowActions confirm={{ label: 'Save', run: () => void save() }} busy={saving} />
    </div>
  );
}
