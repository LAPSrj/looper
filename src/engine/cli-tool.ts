import fs from 'node:fs';
import path from 'node:path';

/*
 * Looper's command-line tool (`looper`) on every session's PATH. The app's
 * own copy is inside app.asar, which a session's shell can't read, so the
 * engine keeps a copy in the data dir, and each session's bin folder gets a
 * `looper` that runs it (Target.renderCliHelper).
 */

/** The data dir's copy of the tool's entry script. */
export const cliScript = (dataDir: string): string => path.join(dataDir, 'cli', 'cli.js');

/**
 * How `looper` starts the desktop app when it isn't running, as the app last
 * recorded it: a program to run, or on macOS the .app to `open`. The app's
 * own folder is out of a shell's reach, so the record goes beside the tool.
 */
export interface AppLaunch {
  version: 1;
  command?: string;
  args?: string[];
  bundle?: string;
}

export const appLaunchFile = (dataDir: string): string => path.join(path.dirname(cliScript(dataDir)), 'app.json');

/** Record how to start this app; null removes the record (a copy macOS runs from a temporary folder). */
export async function writeAppLaunch(dataDir: string, launch: Omit<AppLaunch, 'version'> | null): Promise<void> {
  const file = appLaunchFile(dataDir);
  if (!launch) return fs.promises.rm(file, { force: true });
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, ...launch } satisfies AppLaunch, null, 2) + '\n', 'utf8');
  await fs.promises.rename(tmp, file);
}

/** The recorded way to start the app, or null when there's none this tool reads. */
export function readAppLaunch(dataDir: string): AppLaunch | null {
  try {
    const v = JSON.parse(fs.readFileSync(appLaunchFile(dataDir), 'utf8')) as Partial<AppLaunch> | null;
    if (v?.version !== 1) return null;
    if (typeof v.bundle === 'string') return { version: 1, bundle: v.bundle };
    if (typeof v.command === 'string') return { version: 1, command: v.command, args: Array.isArray(v.args) ? v.args.filter((a) => typeof a === 'string') : [] };
  } catch {
    /* none recorded */
  }
  return null;
}

/** Copy the files of the tool's folder (`source`, out/cli) that changed into the data dir; how many it copied. */
export async function installCli(source: string, dataDir: string): Promise<number> {
  const dest = path.dirname(cliScript(dataDir));
  if (path.resolve(source) === path.resolve(dest)) return 0;
  await fs.promises.mkdir(dest, { recursive: true });
  let copied = 0;
  for (const name of await fs.promises.readdir(source)) {
    if (!name.endsWith('.js')) continue;
    const want = await fs.promises.readFile(path.join(source, name));
    const have = await fs.promises.readFile(path.join(dest, name)).catch(() => null);
    if (have?.equals(want)) continue;
    // A session may be starting the tool right now: it reads either the old file or the new one whole.
    const tmp = path.join(dest, `${name}.${process.pid}.tmp`);
    await fs.promises.writeFile(tmp, want);
    await fs.promises.rename(tmp, path.join(dest, name));
    copied++;
  }
  return copied;
}
