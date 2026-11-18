import { RenameWindow } from './components/RenameWindow';
import { SESSIONS } from './components/hooks';

/**
 * Rename… on a chat or terminal session: its name, shown in the Chats list,
 * its window's title, the dashboard and History. An empty name goes back to
 * the automatic one.
 */
export function SessionNameApp({ sessionId }: { sessionId: string }) {
  return (
    <RenameWindow
      title="Rename"
      source={SESSIONS}
      id={sessionId}
      nameOf={(s) => s.title}
      rename={(name) => window.looper.sessions.rename(sessionId, name)}
      gone="This conversation is closed."
      allowEmpty
    />
  );
}
