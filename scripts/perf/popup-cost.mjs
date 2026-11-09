// What a window for menus that reach past their window's edges would cost: the app's memory with the main window,
// then with a hidden transparent popup window on the same page process, then with it shown over the work area.
import * as path from 'node:path';
import { launch, quit, sleep, seeded, memory, APP_DIR } from './lib.mjs';

await seeded();
const { app } = await launch();
await sleep(6000);
const show = (m) => console.log(JSON.stringify({ taskManagerMb: m.taskManagerMb, privateMb: m.privateMb, ...m.tmByType }));
show(await memory(app));
await app.evaluate(
  ({ BrowserWindow, screen }, { preload, html }) => {
    const work = screen.getPrimaryDisplay().workArea;
    // POPUP=menu: only a menu's size; otherwise the whole work area.
    const area = process.env.POPUP === 'menu' ? { x: work.x + 200, y: work.y + 200, width: 320, height: 420 } : work;
    const w = new BrowserWindow({
      ...area,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    w.setIgnoreMouseEvents(true, { forward: true });
    void w.loadFile(html, { hash: 'about' });
    globalThis.__popup = w;
  },
  { preload: path.join(APP_DIR, 'out', 'preload', 'index.js'), html: path.join(APP_DIR, 'out', 'renderer', 'index.html') },
);
await sleep(4000);
console.log('hidden popup window:');
show(await memory(app));
await app.evaluate(() => globalThis.__popup.showInactive());
await sleep(3000);
console.log('shown over the work area:');
show(await memory(app));
await app.evaluate(() => globalThis.__popup.hide());
await sleep(3000);
console.log('hidden again:');
show(await memory(app));
await quit(app);
