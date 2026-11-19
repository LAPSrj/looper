import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddonSide } from '../../shared/addons';

/**
 * git's prompts (a username, a password, an SSH key's passphrase, an unknown
 * host's key, sudo's password) answered by a window of the addon's instead of
 * a terminal. git, ssh and sudo run a small script (GIT_ASKPASS, SSH_ASKPASS,
 * SUDO_ASKPASS) for each prompt; it runs Looper's executable as Node with
 * askpass.js, which sends the prompt and its command's token to this server
 * (a named pipe on Windows, a Unix socket in a private folder elsewhere) and
 * prints the answer. Answers stay in memory: none is logged or written.
 */

/** Where Looper itself runs (initialize's `host`). */
export type Host = 'windows' | 'wsl' | 'linux' | 'mac';

export const randomId = (bytes = 16): string => randomBytes(bytes).toString('hex');

/** The script git, ssh and sudo run with the prompt. The same text everywhere: from WSL, ELECTRON_RUN_AS_NODE has to be in WSLENV to reach Looper.exe. */
export const ASKPASS_SCRIPT = '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 WSLENV="${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE" exec "$LOOPER_ASKPASS_BIN" "$LOOPER_ASKPASS_JS" "$1"';

/**
 * For a WSL program run from Looper on Windows: writes ASKPASS_SCRIPT
 * (LOOPER_ASKPASS_SCRIPT) into a folder of the user's own in the distro when
 * it isn't there yet, finds Looper.exe's path in the distro's form and runs
 * the command with the askpass variables set. Exits 125 when it can't.
 */
export const WSL_WRAPPER = [
  'd="${XDG_RUNTIME_DIR:-/tmp}/looper-askpass-$(id -u)"',
  '[ -d "$d" ] || mkdir -m 700 "$d" 2>/dev/null || [ -d "$d" ] || { echo "Looper couldn\'t create $d." >&2; exit 125; }',
  '[ -O "$d" ] || { echo "$d belongs to another user." >&2; exit 125; }',
  'f="$d/askpass"',
  'if [ ! -x "$f" ] || [ "$(cat "$f")" != "$LOOPER_ASKPASS_SCRIPT" ]; then printf \'%s\\n\' "$LOOPER_ASKPASS_SCRIPT" > "$f.$$" && chmod 700 "$f.$$" && mv -f "$f.$$" "$f" || exit 125; fi',
  'LOOPER_ASKPASS_BIN=$(wslpath -u "$LOOPER_ASKPASS_EXE") || exit 125',
  'export LOOPER_ASKPASS_BIN GIT_ASKPASS="$f" SSH_ASKPASS="$f" SSH_ASKPASS_REQUIRE=force SUDO_ASKPASS="$f"',
  'exec "$@"',
].join('\n');

// ---------- Prompts ----------

/** What a prompt asks for, from its text. */
export type Prompt =
  | { kind: 'username'; text: string; host: string }
  | { kind: 'password'; text: string; host: string; user?: string }
  | { kind: 'passphrase'; text: string; key?: string }
  | { kind: 'pin'; text: string; key?: string }
  | { kind: 'sudo'; text: string; user: string }
  | { kind: 'hostKey'; text: string; host: string; keyType?: string; fingerprint?: string }
  | { kind: 'confirm'; text: string }
  | { kind: 'other'; text: string; secret: boolean };

/** A URL's host (and port), and the user name in it: "https://me@example.com/x" is example.com and me. */
function urlParts(url: string): { host: string; user?: string } {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:([^@/]*)@)?([^/?#]*)/i.exec(url.trim());
  const host = m?.[2] || url.trim();
  if (!m?.[1]) return { host };
  let user = m[1].replace(/:.*$/, '');
  try {
    user = decodeURIComponent(user);
  } catch {
    // Left as written.
  }
  return { host, ...(user ? { user } : {}) };
}

export function classifyPrompt(text: string): Prompt {
  const t = text.replace(/\r/g, '');
  const last = t.trim().split('\n').pop()!.trim();
  let m: RegExpExecArray | null;
  if ((m = /^Username for '([^']*)':?$/i.exec(last))) return { kind: 'username', text, host: urlParts(m[1]).host };
  if ((m = /^Password for '([^']*)':?$/i.exec(last))) return { kind: 'password', text, ...urlParts(m[1]) };
  if ((m = /^\[sudo\] password for ([^:]+):$/.exec(last))) return { kind: 'sudo', text, user: m[1].trim() };
  if ((m = /^Enter passphrase(?: for (?:key )?'?(.+?)'?)?:$/i.exec(last))) return { kind: 'passphrase', text, ...(m[1] ? { key: m[1] } : {}) };
  if ((m = /^Enter PIN(?: for (?:key )?'?(.+?)'?)?:$/i.exec(last))) return { kind: 'pin', text, ...(m[1] ? { key: m[1] } : {}) };
  if (/\(yes\/no(?:\/\[fingerprint\])?\)\?$/i.test(last)) {
    const host = /authenticity of host '([^']+)'/i.exec(t)?.[1];
    if (!host) return { kind: 'confirm', text };
    const fp = /^(\S+) key fingerprint is (\S+?)\.?$/im.exec(t);
    return { kind: 'hostKey', text, host, ...(fp ? { keyType: fp[1], fingerprint: fp[2] } : {}) };
  }
  if ((m = /^(\S+)'s password:$/.exec(last))) {
    const at = m[1].lastIndexOf('@');
    return at > 0 ? { kind: 'password', text, user: m[1].slice(0, at), host: m[1].slice(at + 1) } : { kind: 'password', text, host: m[1] };
  }
  return { kind: 'other', text, secret: /password|passphrase|token|pin\b|secret/i.test(t) };
}

// ---------- The server ----------

/** One action of the user's (a Pull, a Sync, a clone): the commands it runs share it. */
export interface AskContext {
  /** The Looper `event` request being answered: a prompt's window opens over the window it came from. */
  request?: number;
  /** What the commands are for, when it isn't git talking to a remote: sudo's window says so. */
  purpose?: 'install';
  /** A prompt's window was closed without an answer: the command failed because the user said no. */
  cancelled: boolean;
  /** The answers of the action's commands that succeeded, by prompt, so Sync's push doesn't ask again for what its pull did. */
  remembered: Map<string, string>;
}

export const askContext = (request?: number, purpose?: AskContext['purpose']): AskContext => ({
  ...(request ? { request } : {}),
  ...(purpose ? { purpose } : {}),
  cancelled: false,
  remembered: new Map(),
});

/** What a prompt's window gave: the answer (and a sign-in's password, for git's next prompt), or none. */
export type Asked = { answer: string; password?: string } | 'cancelled' | 'failed';
/** Shows the prompt and resolves with what the user did; `retry`: the same command asked it before, so that answer didn't work. */
export type Ask = (prompt: Prompt, o: { retry: boolean; ctx: AskContext }) => Promise<Asked>;

/** A command that may prompt: the variables (and, for WSL from Windows, the command line) that point its prompts here. */
export interface AskpassCommand {
  token: string;
  env: Record<string, string>;
  wrap: (argv: string[]) => string[];
  /** The command ended: its token stops working, and when it succeeded its answers are kept for the action's next commands. */
  done: (ok: boolean) => void;
}

interface Running {
  ctx: AskContext;
  /** This command's prompts and their answers. */
  asked: Map<string, string>;
  /** The password the sign-in window took with the user name, for git's prompt that follows it. */
  password?: { host: string; value: string };
  ended: boolean;
}

/** The longest line a client may send. */
const LINE_MAX = 64 * 1024;

export class AskpassServer {
  private server?: Server;
  private starting?: Promise<boolean>;
  /** The private folder of the socket and the script (not on Windows). */
  private dir?: string;
  private pipe = '';
  private script = '';
  private readonly tokens = new Map<string, Running>();
  private closed = false;

  constructor(
    private readonly o: {
      host: Host;
      /** Where the script goes on Windows: the addon's data folder. */
      dataDir?: string;
      /** Looper's executable (the addon's own process.execPath) and askpass.js, in the form Looper's side uses. */
      exe: string;
      client: string;
      ask: Ask;
      log?: (line: string) => void;
    },
  ) {}

  /**
   * How a program on `side` reaches the server: across WSL (a WSL program from
   * Looper on Windows), directly (the same side), or not at all (a Windows
   * program from Looper in WSL can't run Looper's Linux executable).
   */
  mode(side: AddonSide): 'cross' | 'direct' | undefined {
    if (this.o.host === 'windows') return side === 'wsl' ? 'cross' : 'direct';
    return side === 'wsl' ? 'direct' : undefined;
  }

  /** A token and the variables for one command on `side`; undefined when its prompts can't be answered (it then fails as git does without a terminal). */
  async command(ctx: AskContext, side: AddonSide): Promise<AskpassCommand | undefined> {
    const mode = this.mode(side);
    if (!mode || this.closed || !(await this.start())) return undefined;
    const token = randomId();
    const run: Running = { ctx, asked: new Map(), ended: false };
    this.tokens.set(token, run);
    const base = { LOOPER_ASKPASS_PIPE: this.pipe, LOOPER_ASKPASS_TOKEN: token, LOOPER_ASKPASS_JS: this.o.client };
    const s = this.script;
    const env: Record<string, string> =
      mode === 'cross'
        ? { ...base, LOOPER_ASKPASS_EXE: this.o.exe, LOOPER_ASKPASS_SCRIPT: ASKPASS_SCRIPT }
        : { ...base, LOOPER_ASKPASS_BIN: this.o.exe, GIT_ASKPASS: s, SSH_ASKPASS: s, SSH_ASKPASS_REQUIRE: 'force', SUDO_ASKPASS: s };
    return {
      token,
      env,
      wrap: mode === 'cross' ? (argv) => ['sh', '-c', WSL_WRAPPER, 'sh', ...argv] : (argv) => argv,
      done: (ok) => {
        if (run.ended) return;
        run.ended = true;
        this.tokens.delete(token);
        if (ok) for (const [prompt, answer] of run.asked) ctx.remembered.set(prompt, answer);
      },
    };
  }

  /** The answer to a prompt from the command with `token`; undefined: none (an unknown token, or the user cancelled). */
  async answer(token: unknown, text: unknown): Promise<string | undefined> {
    const run = typeof token === 'string' ? this.tokens.get(token) : undefined;
    if (!run || typeof text !== 'string') return undefined;
    const prompt = classifyPrompt(text);
    if (prompt.kind === 'password' && run.password && run.password.host === prompt.host) {
      const value = run.password.value;
      run.password = undefined;
      run.asked.set(text, value);
      return value;
    }
    const known = run.ctx.remembered.get(text);
    if (known !== undefined && !run.asked.has(text)) {
      run.asked.set(text, known);
      return known;
    }
    const got = await this.o.ask(prompt, { retry: run.asked.has(text), ctx: run.ctx });
    if (got === 'cancelled') run.ctx.cancelled = true;
    if (typeof got === 'string' || run.ended) return undefined;
    run.asked.set(text, got.answer);
    if (prompt.kind === 'username' && got.password) run.password = { host: prompt.host, value: got.password };
    return got.answer;
  }

  /** Listens, the first time a command needs it; false when it can't. */
  start(): Promise<boolean> {
    this.starting ??= this.listen().then(
      () => true,
      (e: unknown) => {
        this.o.log?.(`git's prompts can't be answered: ${(e as Error).message}`);
        this.starting = undefined;
        return false;
      },
    );
    return this.starting;
  }

  private async listen(): Promise<void> {
    if (this.o.host === 'windows') {
      this.pipe = `\\\\.\\pipe\\looper-git-askpass-${randomId()}`;
      const dir = this.o.dataDir || tmpdir();
      await mkdir(dir, { recursive: true });
      this.script = path.join(dir, 'askpass.sh');
      await writeFile(this.script, `${ASKPASS_SCRIPT}\n`);
    } else {
      // mkdtemp makes the folder for this user alone (0700).
      this.dir = await mkdtemp(path.join(tmpdir(), 'looper-git-'));
      this.pipe = path.join(this.dir, 'askpass.sock');
      this.script = path.join(this.dir, 'askpass');
      await writeFile(this.script, `${ASKPASS_SCRIPT}\n`, { mode: 0o700 });
    }
    const server = createServer((s) => this.connection(s));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.pipe, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (e) => this.o.log?.(`The askpass server failed: ${e.message}`));
    this.server = server;
    if (this.closed) this.close();
  }

  private connection(sock: Socket): void {
    let buf: string | null = '';
    sock.setEncoding('utf8');
    sock.on('error', () => undefined);
    sock.on('data', (d: string) => {
      if (buf === null) return;
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) {
        if (buf.length > LINE_MAX) sock.destroy();
        return;
      }
      const line = buf.slice(0, nl);
      buf = null;
      let msg: { token?: unknown; prompt?: unknown } = {};
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        // Not a client of ours: no answer.
      }
      void this.answer(msg.token, msg.prompt).then(
        (answer) => {
          if (!sock.destroyed) sock.end(`${JSON.stringify(answer === undefined ? {} : { answer })}\n`);
        },
        () => sock.destroy(),
      );
    });
  }

  /** Stop listening; the tokens stop working. */
  close(): void {
    this.closed = true;
    for (const run of this.tokens.values()) run.ended = true;
    this.tokens.clear();
    this.server?.close();
    this.server = undefined;
    if (this.dir) {
      const dir = this.dir;
      this.dir = undefined;
      void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
