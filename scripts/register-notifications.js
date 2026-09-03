// Registers Looper's dev AppUserModelID (com.lemorim.looper.dev) for
// UNPACKAGED runs on Windows (npm run dev / electron .), so the app shows its
// own name and icon instead of Electron's. The dev id is deliberately NOT the
// packaged appId (com.lemorim.looper): a shortcut targeting electron.exe under
// the packaged id would hijack the packaged app's taskbar identity.
//
// - A Start Menu shortcut carrying the AppUserModelID: the taskbar resolves a
//   grouped button's icon through it; without one it falls back to the icon
//   of the running executable — electron.exe.
// - The AppUserModelId registry entry (DisplayName + IconUri): toast
//   attribution in notifications and the Windows notification settings list.
//
// The packaged installer needs none of this: its own Start Menu shortcut
// registers everything the standard way.
//
// Run once per machine/user, from the repo on the Windows side:
//   npm run register:notifications
const { app, shell } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const AUMID = 'com.lemorim.looper.dev';
const repo = path.resolve(__dirname, '..');
const icon = path.join(repo, 'assets', 'icon.ico');

app.whenReady().then(() => {
  try {
    if (process.platform !== 'win32') throw new Error('Windows only.');
    if (!fs.existsSync(icon)) throw new Error(`icon not found: ${icon}`);

    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Looper (dev).lnk');
    const ok = shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', {
      // Launching the shortcut runs the unpackaged app: electron.exe <repo>.
      target: process.execPath,
      args: `"${repo}"`,
      cwd: repo,
      icon,
      iconIndex: 0,
      appUserModelId: AUMID,
      description: 'Looper (unpackaged)',
    });
    if (!ok) throw new Error(`could not write ${lnk}`);
    console.log(`shortcut: ${lnk}`);

    const key = `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`;
    execFileSync('reg.exe', ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'Looper (dev)', '/f'], { stdio: 'ignore' });
    execFileSync('reg.exe', ['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', icon, '/f'], { stdio: 'ignore' });
    console.log(`registry: ${key} (DisplayName=Looper (dev), IconUri=${icon})`);

    console.log(`registered ${AUMID}`);
    app.exit(0);
  } catch (err) {
    console.error(String(err));
    app.exit(1);
  }
});
