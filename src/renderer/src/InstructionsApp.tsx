import { useEffect, useRef, useState } from 'react';
import { Markdown } from './components/Markdown';
import { Toolbar } from './components/Toolbar';

const HOME = 'README.md';

// Every user-guide page, bundled at build time; a page loads when it's shown.
const pages: Record<string, () => Promise<string>> = {};
for (const [file, load] of Object.entries(
  import.meta.glob<string>('../../../docs/*.md', { query: '?raw', import: 'default', eager: false }),
)) {
  pages[file.split('/').pop()!] = load;
}

// Every image the guide references, bundled too; keyed by the docs-relative
// path the markdown uses ("img/<name>").
const images: Record<string, string> = {};
for (const [file, url] of Object.entries(
  import.meta.glob('../../../docs/img/*', { query: '?url', import: 'default', eager: true }),
)) {
  images['img/' + file.split('/').pop()!] = url as string;
}

/** Standalone window browsing the user guide in docs/ (Help → Instructions). */
export function InstructionsApp() {
  const [history, setHistory] = useState<string[]>([HOME]);
  const [pos, setPos] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const page = history[pos];
  // The text of the page shown; the previous one stays until the next has loaded.
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Instructions';
  }, []);

  useEffect(() => {
    let current = true;
    const load = pages[page];
    if (!load) setText('Page not found.');
    else void load().then((t) => current && setText(t));
    return () => {
      current = false;
    };
  }, [page]);

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
  }, [text]);

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

  const forwardItem = { id: 'forward', label: 'Forward', enabled: pos < history.length - 1, run: forward };
  const homeItem = { id: 'home', label: 'Home', enabled: page !== HOME, run: () => open(HOME) };

  return (
    <div className="instructions-app">
      <Toolbar
        groups={[
          {
            id: 'pages',
            items: [
              { id: 'back', label: 'Back', shortcut: 'Alt+Left', icon: 'previous', enabled: pos > 0, run: back },
              { ...forwardItem, shortcut: 'Alt+Right', icon: 'next' },
            ],
          },
          { id: 'home', items: [{ ...homeItem, icon: 'home' }] },
        ]}
        nav={{ back: pos > 0 ? back : undefined, toolbar: [{ id: 'pages', items: [forwardItem, homeItem] }] }}
      />
      <div className="instructions" ref={scrollRef}>
        {text !== null && (
          <Markdown
            text={text}
            breaks={false}
            onNavigate={onNavigate}
            resolveImage={(src) => images[src.replace(/^\.\//, '')]}
          />
        )}
      </div>
    </div>
  );
}
