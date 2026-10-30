import { useEffect } from 'react';
import { TerminalView } from './components/TerminalView';

/** A Remote Control conversation's terminal window. */
export function TerminalSessionApp({ id, title }: { id: string; title: string }) {
  useEffect(() => {
    document.title = title;
  }, [title]);
  return <TerminalView id={id} />;
}
