import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AskpassServer, askContext, classifyPrompt, type Ask, type AskContext, type Asked, type Prompt } from '../src/addons/git/askpass';
import { promptAnswer, promptWindow } from '../src/addons/git/prompt-window';
import { AddonScreenSchema, type AddonNode } from '../src/shared/addons';

const HOST_KEY =
  "The authenticity of host 'github.com (140.82.114.4)' can't be established.\nED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\nThis key is not known by any other names\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";

describe('classifyPrompt', () => {
  it.each<[string, Partial<Prompt>]>([
    ["Username for 'https://example.com': ", { kind: 'username', host: 'example.com' }],
    ["Password for 'https://secret123@example.com': ", { kind: 'password', host: 'example.com', user: 'secret123' }],
    ["Password for 'https://me%40work.com@git.example.com:8443': ", { kind: 'password', host: 'git.example.com:8443', user: 'me@work.com' }],
    ['Enter passphrase: ', { kind: 'passphrase' }],
    ["Enter passphrase for key '/home/me/.ssh/id_ed25519': ", { kind: 'passphrase', key: '/home/me/.ssh/id_ed25519' }],
    ['[sudo] password for leandro: ', { kind: 'sudo', user: 'leandro' }],
    ["git@example.com's password: ", { kind: 'password', user: 'git', host: 'example.com' }],
    ["Enter PIN for 'ECDSA-SK key': ", { kind: 'pin', key: 'ECDSA-SK key' }],
    [HOST_KEY, { kind: 'hostKey', host: 'github.com (140.82.114.4)', keyType: 'ED25519', fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' }],
    ['Warning: the key differs.\nAre you sure you want to continue connecting (yes/no)? ', { kind: 'confirm' }],
    ['Token: ', { kind: 'other', secret: true }],
    ['Favourite colour: ', { kind: 'other', secret: false }],
  ])('reads %j', (text, expected) => {
    expect(classifyPrompt(text)).toEqual({ text, ...expected });
  });
});

describe("a prompt's window", () => {
  const all = [
    "Username for 'https://example.com': ",
    "Password for 'https://me@example.com': ",
    "Enter passphrase for key '/home/me/.ssh/id_ed25519': ",
    'Enter PIN: ',
    '[sudo] password for leandro: ',
    HOST_KEY,
    'Are you sure you want to continue connecting (yes/no)? ',
    'Token: ',
  ].map(classifyPrompt);

  it('is a screen Looper accepts, with one primary button and room for what it holds', () => {
    for (const p of all) {
      for (const retry of [false, true]) {
        const w = promptWindow(p, retry);
        expect(AddonScreenSchema.safeParse(w.screen).success, p.text).toBe(true);
        expect(w.screen.body.filter((n) => n.type === 'footer')).toHaveLength(1);
        expect(w.width).toBeGreaterThanOrEqual(460);
        expect(w.height).toBeLessThanOrEqual(400);
        // Asked again, the refused answer's problem is under its password field (Windows' in-place error), never a bar.
        const secret = w.screen.body.some((n) => n.type === 'field' && n.input === 'password');
        expect(w.screen.body.some((n) => n.type === 'field' && !!n.error)).toBe(retry && secret);
        expect(w.screen.body.some((n) => n.type === 'infobar')).toBe(false);
      }
    }
  });

  it('asks a sign-in for the user name and the password together', () => {
    const w = promptWindow(all[0], false);
    expect(w.title).toBe('Sign In');
    expect(w.screen.instruction).toBe('Sign in to example.com');
    const fields = w.screen.body.filter((n): n is Extract<AddonNode, { type: 'field' }> => n.type === 'field');
    expect(fields.map((f) => [f.id, f.input, f.required ?? false])).toEqual([
      ['username', 'text', true],
      ['password', 'password', false],
    ]);
    expect(promptAnswer(all[0], { username: 'me', password: 's3cret' })).toEqual({ answer: 'me', password: 's3cret' });
    expect(promptAnswer(all[0], { username: 'me', password: '' })).toEqual({ answer: 'me' });
  });

  it('hides what is secret, and names the primary button by what it does', () => {
    const footer = (p: Prompt, purpose?: 'install') => promptWindow(p, false, purpose).screen.body.find((n) => n.type === 'footer') as { primary: { label: string } };
    expect(promptWindow(all[1], false).screen.instruction).toBe('Sign in to example.com as me');
    expect(footer(all[2]).primary.label).toBe('Unlock');
    expect(footer(all[4], 'install').primary.label).toBe('Install');
    expect(promptWindow(all[4], false, 'install').title).toBe('Install Git');
    expect(footer(all[5]).primary.label).toBe('Connect');
    for (const p of [all[1], all[2], all[3], all[4], all[7]]) {
      const field = promptWindow(p, false).screen.body.find((n) => n.type === 'field') as { input: string };
      expect(field.input, p.text).toBe('password');
    }
  });

  it("shows an unknown host's fingerprint, and answers yes to Connect", () => {
    const w = promptWindow(all[5], false);
    expect(w.title).toBe('Unknown Host');
    expect(w.screen.instruction).toBe('Connect to github.com?');
    const props = w.screen.body.find((n) => n.type === 'props') as Extract<AddonNode, { type: 'props' }>;
    expect(props.items).toEqual([
      { label: 'Host', value: 'github.com (140.82.114.4)' },
      { label: 'ED25519 fingerprint', value: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU', mono: true, copy: true },
    ]);
    expect(promptAnswer(all[5], {})).toEqual({ answer: 'yes' });
    expect(promptAnswer(all[2], { answer: 'phrase' })).toEqual({ answer: 'phrase' });
  });
});

/** What a client of the server gets back for a prompt: the answer, or undefined when there's none. */
function client(pipe: string, token: string, prompt: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const sock = connect(pipe);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ token, prompt })}\n`));
    sock.on('data', (d: string) => (buf += d));
    sock.on('error', reject);
    sock.on('close', () => resolve((JSON.parse(buf.trim() || '{}') as { answer?: string }).answer));
  });
}

describe('the askpass server', () => {
  let server: AskpassServer | undefined;
  afterEach(() => server?.close());

  function start(ask: Ask): AskpassServer {
    server = new AskpassServer({ host: 'linux', exe: process.execPath, client: '/x/askpass.js', ask });
    return server;
  }

  it('gives each command a token and the variables that point its prompts at a private socket', async () => {
    const s = start(async () => ({ answer: 'x' }));
    const a = (await s.command(askContext(), 'wsl'))!;
    const b = (await s.command(askContext(), 'wsl'))!;
    expect(a.token).toMatch(/^[0-9a-f]{32}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.env).toMatchObject({ LOOPER_ASKPASS_TOKEN: a.token, LOOPER_ASKPASS_BIN: process.execPath, LOOPER_ASKPASS_JS: '/x/askpass.js', SSH_ASKPASS_REQUIRE: 'force' });
    expect(a.env.GIT_ASKPASS).toBe(a.env.SSH_ASKPASS);
    expect(a.env.SUDO_ASKPASS).toBe(a.env.GIT_ASKPASS);
    expect(a.env.LOOPER_ASKPASS_PIPE).toMatch(/askpass\.sock$/);
    expect(a.wrap(['git', 'pull'])).toEqual(['git', 'pull']);
    // A Windows program from Looper in WSL can't run Looper's executable.
    expect(await s.command(askContext(), 'windows')).toBeUndefined();
  });

  it('crosses into WSL from Looper on Windows through a wrapper and WSLENV', () => {
    const s = new AskpassServer({ host: 'windows', exe: 'C:\\L\\Looper.exe', client: 'C:\\L\\askpass.js', ask: async () => 'failed' });
    expect(s.mode('wsl')).toBe('cross');
    expect(s.mode('windows')).toBe('direct');
  });

  it('answers a known token through the window, and nothing to an unknown one', async () => {
    const asked: { prompt: Prompt; retry: boolean; ctx: AskContext }[] = [];
    const s = start(async (prompt, o) => {
      asked.push({ prompt, ...o });
      return { answer: 'hunter2' };
    });
    const ctx = askContext(7);
    const cmd = (await s.command(ctx, 'wsl'))!;
    const pipe = cmd.env.LOOPER_ASKPASS_PIPE;
    expect(await client(pipe, cmd.token, "Enter passphrase for key '/k': ")).toBe('hunter2');
    expect(asked).toMatchObject([{ prompt: { kind: 'passphrase', key: '/k' }, retry: false, ctx: { request: 7 } }]);
    // Asked again by the same command: the first answer didn't work.
    expect(await client(pipe, cmd.token, "Enter passphrase for key '/k': ")).toBe('hunter2');
    expect(asked[1].retry).toBe(true);
    expect(await client(pipe, 'f'.repeat(32), 'Password: ')).toBeUndefined();
    cmd.done(true);
    // Its command ended: the token stops working.
    expect(await client(pipe, cmd.token, 'Password: ')).toBeUndefined();
    expect(asked).toHaveLength(2);
  });

  it('cancels when the window is closed without an answer', async () => {
    const s = start(async () => 'cancelled');
    const ctx = askContext();
    const cmd = (await s.command(ctx, 'wsl'))!;
    expect(await client(cmd.env.LOOPER_ASKPASS_PIPE, cmd.token, "Username for 'https://example.com': ")).toBeUndefined();
    expect(ctx.cancelled).toBe(true);
  });

  it("doesn't call a window that couldn't open a cancel", async () => {
    const s = start(async () => 'failed');
    const ctx = askContext();
    const cmd = (await s.command(ctx, 'wsl'))!;
    expect(await client(cmd.env.LOOPER_ASKPASS_PIPE, cmd.token, 'Password: ')).toBeUndefined();
    expect(ctx.cancelled).toBe(false);
  });

  it("gives git the password the sign-in window took with the user name", async () => {
    let windows = 0;
    const s = start(async (): Promise<Asked> => {
      windows++;
      return { answer: 'me', password: 'pw' };
    });
    const cmd = (await s.command(askContext(), 'wsl'))!;
    const pipe = cmd.env.LOOPER_ASKPASS_PIPE;
    expect(await client(pipe, cmd.token, "Username for 'https://example.com': ")).toBe('me');
    expect(await client(pipe, cmd.token, "Password for 'https://me@example.com': ")).toBe('pw');
    expect(windows).toBe(1);
  });

  it("keeps a command's answers for the action's next command only when it succeeded", async () => {
    let windows = 0;
    const s = start(async () => {
      windows++;
      return { answer: `answer ${windows}` };
    });
    const prompt = "Enter passphrase for key '/k': ";
    const ctx = askContext();
    const pull = (await s.command(ctx, 'wsl'))!;
    expect(await client(pull.env.LOOPER_ASKPASS_PIPE, pull.token, prompt)).toBe('answer 1');
    pull.done(true);
    const push = (await s.command(ctx, 'wsl'))!;
    expect(await client(push.env.LOOPER_ASKPASS_PIPE, push.token, prompt)).toBe('answer 1');
    expect(windows).toBe(1);
    push.done(false);

    const other = askContext();
    const failed = (await s.command(other, 'wsl'))!;
    expect(await client(failed.env.LOOPER_ASKPASS_PIPE, failed.token, prompt)).toBe('answer 2');
    failed.done(false);
    const next = (await s.command(other, 'wsl'))!;
    expect(await client(next.env.LOOPER_ASKPASS_PIPE, next.token, prompt)).toBe('answer 3');
    expect(other.remembered.size).toBe(0);
  });
});
