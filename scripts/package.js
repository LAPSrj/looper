// `npm run package` builds the installer for the platform it runs on. On WSL
// the Windows installer is the one wanted, but electron-builder needs wine to
// produce it from Linux — so WSL delegates to a Windows checkout through
// powershell.exe interop instead: LOOPER_WIN_REPO when set, else the
// `wslpath -w` translation of the repo when it lives on a Windows drive
// mount. The Windows checkout builds from its own sources and node_modules.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const onWindows = process.platform === 'win32';

function isWsl() {
  if (onWindows || process.platform === 'darwin') return false;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function platformFlag() {
  if (onWindows) return '--win';
  if (process.platform === 'darwin') return '--mac';
  return isWsl() ? '--win' : '--linux';
}

/** Drive-letter path of the Windows checkout; UNC (\\wsl.localhost) is
 * rejected — cmd.exe, which npm scripts run under, cannot cd to UNC paths. */
function windowsRepoPath() {
  if (process.env.LOOPER_WIN_REPO) return process.env.LOOPER_WIN_REPO;
  const r = spawnSync('wslpath', ['-w', process.cwd()], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  return /^[A-Za-z]:\\/.test(out) ? out : undefined;
}

function run(command, args, opts) {
  const r = spawnSync(command, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (isWsl()) {
  const repo = windowsRepoPath();
  if (!repo) {
    console.error(
      'looper: cannot find the Windows checkout to build in.\n' +
        'Set LOOPER_WIN_REPO to it (e.g. C:\\Users\\me\\repos\\looper, with its own npm install),\n' +
        'or run `npm run package:windows` there directly.',
    );
    process.exit(1);
  }
  const cmd = `Set-Location -LiteralPath '${repo.replace(/'/g, "''")}'; npm run package:windows; exit $LASTEXITCODE`;
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd]);
} else {
  // npm puts node_modules/.bin on PATH; Windows needs the shell for the .cmd shims.
  run('npm', ['run', 'build:all'], { shell: onWindows });
  run('electron-builder', [platformFlag()], { shell: onWindows });
}
