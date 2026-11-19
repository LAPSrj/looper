import { useXterm } from './xterm';

/**
 * A running "!" command's terminal in its message box item: its output so far, then live, and what's typed into it
 * goes to the command (a password, a y/n). `ownerId`: the chat's or the task run's id.
 */
export default function CommandTerminal({ ownerId, id }: { ownerId: string; id: string }) {
  const chat = window.looper.chat;
  const { ref, keys } = useXterm(`${ownerId}/${id}`, {
    replay: (term) =>
      chat.commandScreen(ownerId, id).then((screen) => {
        if (screen) term.write(screen);
      }),
    live: (e, term) => {
      if (e.type === 'chat:command' && e.chatId === ownerId && e.id === id) term.write(e.data);
    },
    write: (d) => chat.writeCommand(ownerId, id, d),
    resize: (cols, rows) => chat.resizeCommand(ownerId, id, cols, rows),
    showMenu: (hasSelection) => chat.showCommandMenu(hasSelection),
    // Ready for a password, unless the user has gone on to type something else meanwhile.
    takesFocus: () => {
      const a = document.activeElement;
      return !a || a === document.body || (a instanceof HTMLTextAreaElement && !!a.closest('.chat-composer') && !a.value);
    },
  });
  return (
    <div className="chat-command-terminal">
      <div className="terminal" ref={ref} />
      {keys}
    </div>
  );
}
