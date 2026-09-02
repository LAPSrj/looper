import { useEffect } from 'react';
import readme from '../../../README.md?raw';
import { Markdown } from './components/Markdown';

/** Standalone window rendering the README (Help → Instructions). */
export function InstructionsApp() {
  useEffect(() => {
    document.title = 'Instructions';
  }, []);
  return (
    <div className="instructions">
      <Markdown text={readme} breaks={false} />
    </div>
  );
}
