// `npm run install-app` installs the release `npm run package` built for this OS and
// starts the new version, reporting to a Looper chat when it's done. Run from a
// chat, everything the chat's agent starts belongs to the Looper being
// replaced, so the work happens in a second copy of this script that nothing
// of Looper's owns: on Windows started through WMI (its parent is WmiPrvSE,
// in the desktop session), elsewhere in a session of its own. On WSL the
// install is the Windows one, handed to the Windows checkout as package.js
// does. Each step goes to <data dir>/release.log.
//
//   node scripts/install.js [--report <id>] [--installer <file>] [--data-dir <dir>] [--dry-run]
//
// --report defaults to the chat or run the command runs in (LOOPER_RUN).
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;
/** A lock not refreshed for this long belongs to a Looper that is gone (engine/lock.ts). */
const STALE_MS = 20_000;

function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const opts = { report: process.env.LOOPER_RUN || undefined, installer: undefined, dataDir: undefined, dryRun: false, run: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value');
      return argv[++i];
    };
    if (a === '--report') opts.report = value();
    else if (a === '--installer') opts.installer = value();
    else if (a === '--data-dir') opts.dataDir = value();
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--run') opts.run = true;
    else throw new Error('unknown option ' + a);
  }
  return opts;
}

/** electron-builder's output folder for this OS: release/<os>-<arch>. */
function releaseDir(platform = process.platform, arch = process.arch) {
  const name = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  return path.join(ROOT, 'release', name + '-' + arch);
}

/** The installer of `version` among a release folder's files: the Windows setup, the macOS zip, or the AppImage. */
function pickInstaller(names, version, platform = process.platform) {
  const ext = platform === 'win32' ? '.exe' : platform === 'darwin' ? '.zip' : '.AppImage';
  const escaped = version.replace(/\./g, '\\.');
  const re = new RegExp('(?<![0-9.])' + escaped + '(?![0-9]|\\.[0-9])');
  return names.find((n) => n.endsWith(ext) && re.test(n) && !n.endsWith('.blockmap'));
}

function defaultDataDir() {
  return process.env.LOOPER_HOME || path.join(os.homedir(), 'looper');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The Looper holding the data dir, or null; a dead pid on this OS frees it (engine/lock.ts). */
function liveHolder(dataDir) {
  const h = readJson(path.join(dataDir, 'engine.lock'));
  if (!h || typeof h.heartbeatAt !== 'number' || Date.now() - h.heartbeatAt > STALE_MS) return null;
  if (h.hostname === os.hostname() && h.pid) {
    try {
      process.kill(h.pid, 0);
    } catch (e) {
      if (e.code !== 'EPERM') return null;
    }
  }
  return h;
}

/** A command to the running Looper's command server (engine/command-server.ts). */
function request(holder, method, params) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: holder.port, method: 'POST', path: '/request', headers: { authorization: 'Bearer ' + holder.token, 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let body = {};
          try {
            body = JSON.parse(text);
          } catch {
            /* reported below */
          }
          if (res.statusCode === 200) resolve(body.result);
          else reject(new Error(body.error || 'Looper answered ' + res.statusCode));
        });
      },
    );
    req.setTimeout(30_000, () => req.destroy(new Error('no answer within 30 s')));
    req.on('error', reject);
    req.end(JSON.stringify({ method, params }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(cond, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(500);
  }
}

// ---------- the half that runs where it was asked ----------

function windowsRepoPath() {
  if (process.env.LOOPER_WIN_REPO) return process.env.LOOPER_WIN_REPO;
  const r = spawnSync('wslpath', ['-w', ROOT], { encoding: 'utf8' });
  const out = (r.stdout || '').trim();
  return /^[A-Za-z]:\\/.test(out) ? out : undefined;
}

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const cmdQuote = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';

/** Start the install half on Windows through WMI, so no process of Looper's owns it. */
function startOnWindows(powershell, node, script, args) {
  const commandLine = [node, script, '--run', ...args].map(cmdQuote).join(' ');
  const ps =
    "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = " + psQuote(commandLine) + " }; " +
    "if ($r.ReturnValue -ne 0) { Write-Error ('WMI could not start it: ' + $r.ReturnValue); exit 1 }";
  const r = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'powershell failed').trim());
}

/** From WSL, a data dir on a Windows drive belongs to the Windows app (cli/connect.ts). */
function onWindowsDrive(dir) {
  const r = spawnSync('wslpath', ['-w', path.resolve(dir)], { encoding: 'utf8' });
  return /^[A-Za-z]:\\/.test((r.stdout || '').trim());
}

function front(opts) {
  // WSL installs the Windows app, as package.js builds it, unless the data dir is WSL's own.
  if (isWsl() && (!opts.dataDir || onWindowsDrive(opts.dataDir))) {
    // The Windows checkout builds and installs the Windows release (package.js).
    const repo = windowsRepoPath();
    if (!repo) throw new Error("cannot find the Windows checkout to install from. Set LOOPER_WIN_REPO to it (e.g. C:\\Users\\me\\repos\\looper).");
    const winVersion = readJson(path.join(execFileSync('wslpath', ['-u', repo], { encoding: 'utf8' }).trim(), 'package.json'))?.version;
    if (winVersion !== VERSION) throw new Error('the Windows checkout is at ' + winVersion + ', not ' + VERSION + ': sync it first.');
    const winDir = execFileSync('wslpath', ['-u', path.win32.join(repo, 'release', 'win-x64')], { encoding: 'utf8' }).trim();
    const name = opts.installer ? null : pickInstaller(listDir(winDir), VERSION, 'win32');
    const installer = opts.installer
      ? execFileSync('wslpath', ['-w', path.resolve(opts.installer)], { encoding: 'utf8' }).trim()
      : name && path.win32.join(repo, 'release', 'win-x64', name);
    if (!installer) throw new Error('no installer of ' + VERSION + ' in ' + winDir + ': build it with npm run package first.');
    const args = ['--installer', installer];
    if (opts.report) args.push('--report', opts.report);
    if (opts.dataDir) args.push('--data-dir', execFileSync('wslpath', ['-w', path.resolve(opts.dataDir)], { encoding: 'utf8' }).trim());
    const node = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Command node).Source'], { encoding: 'utf8' }).stdout.trim();
    if (!node) throw new Error('Node.js is not installed on Windows, which runs the install.');
    const plan = 'install ' + installer + ' on Windows' + (opts.report ? ' and report to ' + opts.report : '');
    if (opts.dryRun) return console.log('would ' + plan + ', with ' + node + ' running ' + repo + '\\scripts\\install.js');
    startOnWindows('powershell.exe', node, path.win32.join(repo, 'scripts', 'install.js'), args);
    return console.log('Installing Looper ' + VERSION + ' on Windows in the background; each step goes to release.log in the data folder' + (opts.report ? ', and the result to ' + opts.report : '') + '.');
  }
  const dir = releaseDir();
  const installer = opts.installer ? path.resolve(opts.installer) : (() => {
    const name = pickInstaller(listDir(dir), VERSION);
    return name && path.join(dir, name);
  })();
  if (!installer || !fs.existsSync(installer)) throw new Error('no installer of ' + VERSION + ' in ' + dir + ': build it with npm run package first.');
  const dataDir = path.resolve(opts.dataDir || defaultDataDir());
  const args = ['--installer', installer, '--data-dir', dataDir];
  if (opts.report) args.push('--report', opts.report);
  if (opts.dryRun) return console.log('would install ' + installer + ' for ' + dataDir + (opts.report ? ' and report to ' + opts.report : ''));
  if (process.platform === 'win32') {
    startOnWindows(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), process.execPath, __filename, args);
  } else {
    // A session of its own: closing the chat's terminal doesn't reach it.
    fs.mkdirSync(dataDir, { recursive: true });
    const out = fs.openSync(path.join(dataDir, 'release.log'), 'a');
    spawn(process.execPath, [__filename, '--run', ...args], { detached: true, stdio: ['ignore', out, out] }).unref();
  }
  console.log('Installing Looper ' + VERSION + ' in the background; each step goes to ' + path.join(dataDir, 'release.log') + (opts.report ? ', and the result to ' + opts.report : '') + '.');
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------- the half that installs ----------

function windowsInstall(installer, log) {
  const r = spawnSync(installer, ['/S'], { stdio: 'ignore', windowsHide: true });
  if (r.error) throw new Error('cannot run the installer: ' + r.error.message);
  if (r.status !== 0) throw new Error('the installer exited with ' + r.status + ' (it quits without installing when it cannot close Looper)');
  // electron-builder registers the app under the user's Uninstall keys.
  const ps =
    "$k = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Looper*' } | Select-Object -First 1; " +
    "if ($k) { $k.DisplayVersion; $k.InstallLocation }";
  const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\r?\n/);
  const [installed, location] = out;
  log('the installer finished; Windows lists Looper ' + (installed || '(none)') + ' in ' + (location || '(unknown)'));
  if (installed !== VERSION) throw new Error('Windows lists Looper ' + (installed || 'as not installed') + ' after the install, not ' + VERSION);
  return path.join(location, 'Looper.exe');
}

function macInstall(installer, dataDir, log) {
  const recorded = readJson(path.join(dataDir, 'cli', 'app.json'));
  const target = recorded && recorded.version === 1 && typeof recorded.bundle === 'string' ? recorded.bundle : '/Applications/Looper.app';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-install-'));
  const unzip = spawnSync('ditto', ['-x', '-k', installer, tmp]);
  if (unzip.status !== 0) throw new Error('cannot unpack ' + installer);
  const app = listDir(tmp).find((n) => n.endsWith('.app'));
  if (!app) throw new Error(installer + ' holds no .app');
  fs.rmSync(target, { recursive: true, force: true });
  if (spawnSync('ditto', [path.join(tmp, app), target]).status !== 0) throw new Error('cannot copy the app to ' + target);
  fs.rmSync(tmp, { recursive: true, force: true });
  const installed = spawnSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(target, 'Contents', 'Info.plist')], { encoding: 'utf8' }).stdout.trim();
  log('copied the app to ' + target + ', version ' + installed);
  if (installed !== VERSION) throw new Error(target + ' is ' + installed + ' after the install, not ' + VERSION);
  return target;
}

function linuxInstall(installer, dataDir, log) {
  const recorded = readJson(path.join(dataDir, 'cli', 'app.json'));
  const target = recorded && recorded.version === 1 && typeof recorded.command === 'string' && recorded.command.endsWith('.AppImage')
    ? recorded.command
    : path.join(os.homedir(), 'Applications', 'Looper.AppImage');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.' + process.pid + '.tmp';
  fs.copyFileSync(installer, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, target);
  log('copied the AppImage to ' + target);
  return target;
}

/** Start Looper on the data dir: the installed app where there's a desktop, looper serve where there isn't. */
function startLooper(app, dataDir, log) {
  const arg = '--data-dir=' + dataDir;
  const detached = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  if (process.platform === 'win32') return detached(app, [arg]);
  if (process.platform === 'darwin' && spawnSync('open', ['-a', app, '--args', arg], { stdio: 'ignore' }).status === 0) return;
  if (process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) return detached(app, [arg]);
  log('no desktop to show the app on, so starting looper serve');
  const out = fs.openSync(path.join(dataDir, 'serve.log'), 'a');
  spawn(process.execPath, [path.join(ROOT, 'out', 'cli', 'cli.js'), '--data-dir', dataDir, 'serve', '--quiet'], { detached: true, stdio: ['ignore', out, out] }).unref();
}

async function back(opts) {
  const dataDir = path.resolve(opts.dataDir || defaultDataDir());
  const logFile = path.join(dataDir, 'release.log');
  const log = (line) => {
    try {
      fs.appendFileSync(logFile, new Date().toISOString() + ' ' + line + '\n');
    } catch {
      /* nowhere to write it */
    }
  };
  log('installing Looper ' + VERSION + ' from ' + opts.installer);
  let step = 'closing Looper';
  let app;
  let failure;
  try {
    const running = liveHolder(dataDir);
    if (running?.port && running.token) {
      log('asking ' + (running.version ? 'Looper ' + running.version : 'Looper') + ' to quit');
      await request(running, 'quit', { force: true }).catch((e) => log('it refused: ' + e.message));
      if (!(await until(() => !liveHolder(dataDir), 90_000))) log("it hasn't quit within 90 s, so the install closes it");
      else log('it quit');
    } else if (running) {
      log('the running Looper takes no commands, so the install closes it');
      if (process.platform !== 'win32') {
        try {
          process.kill(running.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
        await until(() => !liveHolder(dataDir), 30_000);
      }
    } else log("Looper isn't running");
    step = 'installing';
    app = process.platform === 'win32' ? windowsInstall(opts.installer, log) : process.platform === 'darwin' ? macInstall(opts.installer, dataDir, log) : linuxInstall(opts.installer, dataDir, log);
  } catch (e) {
    failure = step + ': ' + e.message;
    log('failed while ' + failure);
  }
  // Even after a failed install, Looper starts again, whichever version is there.
  step = 'starting Looper';
  if (!app && process.platform === 'win32') {
    const recorded = readJson(path.join(dataDir, 'cli', 'app.json'));
    app = recorded?.command;
  }
  let started = null;
  try {
    if (!app) throw new Error("it isn't known where Looper is installed");
    log('starting ' + app);
    startLooper(app, dataDir, log);
    started = await until(() => {
      const h = liveHolder(dataDir);
      return h?.port && h.token ? h : null;
    }, 120_000);
    if (!started) throw new Error("it didn't start within 120 s");
    log('started ' + (started.version ? 'Looper ' + started.version : 'Looper') + ' (process ' + started.pid + ')');
    if (!failure && started.version !== VERSION) failure = 'checking the version: the Looper that started is ' + (started.version || 'an older one') + ', not ' + VERSION;
  } catch (e) {
    failure = (failure ? failure + '; then ' : '') + step + ': ' + e.message;
    log('failed while ' + step + ': ' + e.message);
  }
  const message = failure
    ? 'Installing Looper ' + VERSION + ' failed while ' + failure + '. Each step is in ' + logFile + '.'
    : 'Installed Looper ' + VERSION + ' and started it again. Each step is in ' + logFile + '.';
  log(message);
  if (opts.report && started) {
    await request(started, 'send', { ids: [opts.report], text: message }).then(
      () => log('reported to ' + opts.report),
      (e) => log('cannot report to ' + opts.report + ': ' + e.message),
    );
  }
  process.exitCode = failure ? 1 : 0;
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('install: ' + e.message);
    process.exit(2);
  }
  if (opts.run) void back(opts);
  else {
    try {
      front(opts);
    } catch (e) {
      console.error('install: ' + e.message);
      process.exit(1);
    }
  }
}

module.exports = { parseArgs, pickInstaller, releaseDir };
