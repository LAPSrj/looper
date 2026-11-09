import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = path.join(__dirname, '..', 'src', 'renderer', 'src');
const read = (file: string) => fs.readFileSync(path.join(src, file), 'utf8');
const main = read('main.tsx');

/** Every window app file at the renderer's top level, except the main window's. */
const windowApps = fs
  .readdirSync(src)
  .filter((f) => /^[A-Z]\w*Apps?\.tsx$/.test(f) && f !== 'App.tsx')
  .map((f) => f.replace(/\.tsx$/, ''));

describe('window code splitting (PF-02)', () => {
  it('has found the window apps', () => {
    expect(windowApps.length).toBeGreaterThan(30);
  });

  it('loads every window app through a lazy import in main.tsx, never a static one', () => {
    for (const app of windowApps) {
      expect(main, `${app} lazy import`).toContain(`import('./${app}')`);
      expect(main, `${app} static import`).not.toMatch(new RegExp(`^import .* from './${app}';`, 'm'));
    }
    for (const file of ['components/AddonScreen', 'web/PairPage']) {
      expect(main, `${file} lazy import`).toContain(`import('./${file}')`);
      expect(main, `${file} static import`).not.toMatch(new RegExp(`^import .* from './${file}';`, 'm'));
    }
  });

  it('loads the main window lazily too, so the other windows never load its code', () => {
    expect(main).toContain("import('./App')");
    expect(main).not.toMatch(/^import .* from '\.\/App';/m);
  });

  it('keeps zod out of the chunk every window loads', () => {
    expect(read('../../shared/files.ts')).not.toMatch(/^import (?!type).* from '\.\/(addons|types|validate)';/m);
  });

  it('reports a window ready from inside the Suspense boundary, beside the lazy app', () => {
    expect(main).toMatch(
      /<Suspense fallback=\{null\}>\s*<Measured id=\{rootId\}>\{pickRoot\(\)\}<\/Measured>\s*\{onRendered && <WindowReady onReady=\{report\} \/>\}\s*<\/Suspense>/,
    );
    expect(read('WindowReady.tsx')).toContain('useLayoutEffect');
  });

  it("lazy-loads each platform's frame in the shell", () => {
    const shell = read('web/Shell.tsx');
    for (const frame of ['IosFrame', 'AndroidFrame', 'DesktopFrame']) {
      expect(shell).toContain(`import('./${frame}')`);
      expect(shell).not.toMatch(new RegExp(`^import .* from './${frame}';`, 'm'));
    }
  });

  it('keeps the phone and terminal stylesheets out of the main stylesheet', () => {
    expect(read('styles.css')).not.toMatch(/@import/);
    expect(main).not.toContain('xterm.css');
    expect(read('components/xterm.ts')).toContain("import '@xterm/xterm/css/xterm.css'");
    const keyboard = read('components/phone/keyboard.ts');
    expect(keyboard).toContain("import('../../phone.css?inline')");
    expect(keyboard).not.toMatch(/^import .*phone\.css/m);
  });

  it('loads the docs pages on demand and qrcode on first use', () => {
    expect(read('InstructionsApp.tsx')).toContain('eager: false');
    expect(read('RemoteAccessApps.tsx')).not.toMatch(/^import \{[^}]*\} from 'qrcode';/m);
    expect(read('RemoteAccessApps.tsx')).toContain("import('qrcode')");
  });
});
