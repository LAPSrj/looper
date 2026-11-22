import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandPrompt } from '../src/shared/bash-mode';
import { UserCommands } from '../src/engine/command-output';
import { Logger } from '../src/engine/log';
import type { RunContext } from '../src/engine/steps/common';
import { SUDO_WRAPPER, SudoAskpass, commandPrompt } from '../src/engine/sudo-askpass';
import { BashTarget } from '../src/engine/target';
import { EXAMPLE_TASK } from '../src/shared/example-task';
import { SettingsSchema, TaskSchema } from '../src/shared/types';
import { classifyPrompt } from '../src/addons/git/askpass';

const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/**
 * A stand-in for sudo that needs no real password: with -A it asks SUDO_ASKPASS for it (as sudo does, up to
 * three times) and takes only "hunter2"; it then runs the rest of its command line as the user.
 */
function fakeSudo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sudo');
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      'if [ "$1" = -A ]; then',
      '  shift',
      '  n=0',
      '  while [ $n -lt 3 ]; do',
      '    pw=$("$SUDO_ASKPASS" "[sudo] password for tester: ") || { echo "fake sudo: no password was provided"; exit 1; }',
      '    [ "$pw" = hunter2 ] && { echo "fake sudo: password accepted, length ${#pw}"; exec "$@"; }',
      '    echo "Sorry, try again."',
      '    n=$((n + 1))',
      '  done',
      '  echo "fake sudo: 3 incorrect password attempts"; exit 1',
      'fi',
      'echo "fake sudo without -A: $*"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
}

describe('the sudo wrapper', () => {
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** Runs `sudo args` with the wrapper's folder first on PATH and the fake sudo behind it; what the fake got. */
  function run(...args: string[]): string {
    const bin = tmp('looper-sudo-bin-');
    const wrapper = path.join(bin, 'sudo');
    fs.writeFileSync(wrapper, SUDO_WRAPPER, { mode: 0o755 });
    const real = tmp('looper-sudo-real-');
    fs.writeFileSync(path.join(real, 'sudo'), '#!/bin/sh\necho "real sudo: $*"\n', { mode: 0o755 });
    return execFileSync('sudo', args, { env: { ...process.env, PATH: `${bin}:${real}:${process.env.PATH}` }, encoding: 'utf8' }).trim();
  }

  it('runs the real sudo (the next on PATH, not itself) with -A', () => {
    expect(run('apt', 'update')).toBe('real sudo: -A apt update');
    expect(run('-u', 'bob', 'id')).toBe('real sudo: -A -u bob id');
  });

  it("leaves a command alone that gives the password on stdin, which -A can't be combined with", () => {
    expect(run('-S', 'true')).toBe('real sudo: -S true');
    expect(run('--stdin', 'true')).toBe('real sudo: --stdin true');
    expect(run('-nS', 'true')).toBe('real sudo: -nS true');
    expect(run('-u', 'bob', '-S', 'true')).toBe('real sudo: -u bob -S true');
  });

  it("reads only sudo's own options: the command's arguments and an option's value aren't -S", () => {
    expect(run('ls', '-lS')).toBe('real sudo: -A ls -lS');
    expect(run('sort', '-S', '1G', 'f')).toBe('real sudo: -A sort -S 1G f');
    expect(run('-u', 'bob', 'sort', '-S', '1G')).toBe('real sudo: -A -u bob sort -S 1G');
    expect(run('-p', 'S', 'true')).toBe('real sudo: -A -p S true');
    expect(run('-uS', 'true')).toBe('real sudo: -A -uS true');
    expect(run('--user', 'S', 'true')).toBe('real sudo: -A --user S true');
    expect(run('--', '-S')).toBe('real sudo: -A -- -S');
    expect(run('-E', 'env', '-S')).toBe('real sudo: -A -E env -S');
  });
});

describe('commandPrompt', () => {
  it("words sudo's prompt as a password for its user", () => {
    expect(commandPrompt(classifyPrompt('[sudo] password for leandro: '), false)).toEqual({ text: 'Enter the password for leandro', secret: true, retry: false });
    expect(commandPrompt(classifyPrompt('[sudo] password for leandro: '), true).retry).toBe(true);
  });

  it("asks a custom prompt as it is written, hidden when it's about a password", () => {
    expect(commandPrompt(classifyPrompt('Sudo password: '), false)).toEqual({ text: 'Sudo password', secret: true, retry: false });
    expect(commandPrompt(classifyPrompt('Which one: '), false)).toEqual({ text: 'Which one', secret: false, retry: false });
  });
});

describe("a user's \"!\" command that runs sudo", { timeout: 30_000 }, () => {
  const saved = process.env.PATH;
  const askpasses: SudoAskpass[] = [];
  beforeEach(() => {
    const real = tmp('looper-fake-sudo-');
    fakeSudo(real);
    process.env.PATH = `${real}:${saved}`;
  });
  afterEach(() => {
    process.env.PATH = saved;
    for (const a of askpasses.splice(0)) a.close();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function setUp(withAskpass = true) {
    const runDir = tmp('looper-user-command-');
    const dataDir = tmp('looper-data-');
    const logs: string[] = [];
    const ctx: RunContext = {
      task: TaskSchema.parse({ ...EXAMPLE_TASK, cwd: runDir }),
      runId: 'chat-c1',
      runDir,
      target: new BashTarget({ host: 'linux' }, undefined),
      settings: SettingsSchema.parse({}),
      host: 'linux',
      log: new Logger(),
      dataDir,
      vars: {},
    };
    const askpass = new SudoAskpass({ host: 'linux', dataDir, log: (l) => logs.push(l) });
    askpasses.push(askpass);
    const prompts: (CommandPrompt | null)[] = [];
    // What the terminal printed: the text the agent gets is made by a worker the tests don't start.
    const printed = { text: '' };
    const commands = new UserCommands(ctx, {
      label: 'test',
      onChange: () => undefined,
      onOutput: (_id, data) => (printed.text += data),
      onPrompt: (_id, p) => prompts.push(p),
      ...(withAskpass ? { askpass } : {}),
    });
    return { commands, prompts, printed, runDir, dataDir, logs };
  }

  /** Every file under the folders, as text. */
  const filesText = (...roots: string[]): string =>
    roots
      .flatMap((root) => fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)))
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n');

  it('asks for the password in a prompt of the window, a plain sudo without -A', async () => {
    const { commands, prompts, printed, runDir, dataDir, logs } = setUp();
    const done = commands.run('sudo echo hello', 'c1');
    await until(() => prompts.length === 1, 'the prompt');
    expect(prompts[0]).toMatchObject({ text: 'Enter the password for tester', secret: true, retry: false });
    expect(commands.prompt('c1')).toEqual(prompts[0]);
    commands.answer('c1', prompts[0]!.id, 'hunter2');
    const out = await done;
    expect(prompts[1]).toBeNull();
    expect(commands.prompt('c1')).toBeNull();
    expect(out.exitCode).toBe(0);
    expect(printed.text).toContain('fake sudo: password accepted, length 7');
    expect(printed.text).toContain('hello');
    // The password isn't in what the terminal showed, in a file Looper wrote or in its log.
    expect(printed.text).not.toContain('hunter2');
    expect(filesText(runDir, dataDir)).not.toContain('hunter2');
    expect(logs.join('\n')).not.toContain('hunter2');
  });

  it("asks again, marked as a retry, when the password isn't accepted", async () => {
    const { commands, prompts, printed } = setUp();
    const done = commands.run('sudo true', 'c1');
    await until(() => prompts.length === 1, 'the first prompt');
    commands.answer('c1', prompts[0]!.id, 'wrong');
    await until(() => prompts.length === 3, 'the second prompt');
    expect(prompts[2]).toMatchObject({ retry: true });
    // An answer to the first prompt, late, is dropped.
    commands.answer('c1', prompts[0]!.id, 'hunter2');
    expect(commands.prompt('c1')).toEqual(prompts[2]);
    commands.answer('c1', prompts[2]!.id, 'hunter2');
    await done;
    expect(printed.text).toContain('Sorry, try again.');
    expect(printed.text).toContain('password accepted');
  });

  it('fails the command as sudo does when the prompt is cancelled', async () => {
    const { commands, prompts, printed } = setUp();
    const done = commands.run('sudo true', 'c1');
    await until(() => prompts.length === 1, 'the prompt');
    commands.answer('c1', prompts[0]!.id, null);
    const out = await done;
    expect(out.exitCode).toBe(1);
    expect(printed.text).toContain('no password was provided');
  });

  it('drops the prompt when the command is stopped', async () => {
    const { commands, prompts } = setUp();
    const done = commands.run('sudo true', 'c1');
    await until(() => prompts.length === 1, 'the prompt');
    await commands.stop('c1');
    const out = await done;
    expect(out.stopped).toBe(true);
    expect(prompts.at(-1)).toBeNull();
  });

  it("never starts a command stopped while sudo's prompt is being set up", async () => {
    const { commands, runDir } = setUp();
    const marker = path.join(runDir, 'ran');
    const done = commands.run(`touch ${marker}`, 'c1');
    // The askpass is still being set up: the command isn't running yet.
    expect(commands.size).toBe(0);
    await commands.stop();
    const out = await done;
    expect(out).toMatchObject({ stopped: true, exitCode: null });
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(marker)).toBe(false);
    expect(commands.size).toBe(0);
  });

  it("leaves sudo's own prompt to the terminal where it can't be set up", async () => {
    const { commands, prompts, printed } = setUp(false);
    await commands.run('sudo echo hi', 'c1');
    expect(prompts).toEqual([]);
    expect(printed.text).toContain('fake sudo without -A: echo hi');
  });

  it("gives the agent's own commands nothing", async () => {
    const { commands, runDir } = setUp();
    const done = commands.run('echo $SUDO_ASKPASS-$LOOPER_ASKPASS_TOKEN', 'c1');
    await done;
    // The folder with the wrapper is the command's: the run's own bin folder (the agent's PATH) has no sudo.
    expect(fs.existsSync(path.join(runDir, 'bin', 'sudo'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'sudo-bin', 'sudo'))).toBe(true);
  });
});
