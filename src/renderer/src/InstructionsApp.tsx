import { useEffect, useRef, useState } from 'react';
import { Markdown } from './components/Markdown';

const HOME = 'README.md';

// Every user-guide page, bundled at build time.
const pages: Record<string, string> = {};
for (const [file, text] of Object.entries(
  import.meta.glob('../../../docs/*.md', { query: '?raw', import: 'default', eager: true }),
)) {
  pages[file.split('/').pop()!] = text as string;
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  back: <path d="M10.5 3.2 5.7 8l4.8 4.8" />,
  forward: <path d="m5.5 3.2 4.8 4.8-4.8 4.8" />,
  home: (
    <>
      <path d="m2.2 7.6 5.8-5 5.8 5" />
      <path d="M4 6.8v6.7h8V6.8" />
    </>
  ),
};

/** Standalone window browsing the user guide in docs/ (Help → Instructions). */
export function InstructionsApp() {
  const [history, setHistory] = useState<string[]>([HOME]);
  const [pos, setPos] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const page = history[pos];

  useEffect(() => {
    document.title = 'Instructions';
  }, []);

  const back = () => setPos((p) => Math.max(0, p - 1));
  const forward = () => setPos((p) => Math.min(history.length - 1, p + 1));
  const open = (name: string) => {
    if (!(name in pages) || name === page) return;
    setHistory((h) => [...h.slice(0, pos + 1), name]);
    setPos(pos + 1);
  };

  // A link like "tasks.md", "./tasks.md" or "tasks.md#anchor" goes to that
  // page; anything else (in-page anchors, paths outside docs/) is ignored.
  const onNavigate = (href: string) => {
    const name = href.split('#')[0].replace(/^\.\//, '');
    if (name) open(name);
  };

  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [page]);

  // Alt+arrows and the mouse back/forward buttons, as in a browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft') back();
      else if (e.key === 'ArrowRight') forward();
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) back();
      else if (e.button === 4) forward();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, [history.length]);

  const button = (icon: React.ReactNode, title: string, onClick: () => void, enabled: boolean) => (
    <button title={title} aria-label={title} disabled={!enabled} onClick={onClick}>
      <Icon>{icon}</Icon>
    </button>
  );

  return (
    <div className="instructions-app">
      <div className="toolbar">
        {button(ICONS.back, 'Back (Alt+Left)', back, pos > 0)}
        {button(ICONS.forward, 'Forward (Alt+Right)', forward, pos < history.length - 1)}
        <span className="toolbar-sep" />
        {button(ICONS.home, 'Home', () => open(HOME), page !== HOME)}
      </div>
      <div className="instructions" ref={scrollRef}>
        <Markdown text={pages[page] ?? 'Page not found.'} breaks={false} onNavigate={onNavigate} />
      </div>
    </div>
  );
}
