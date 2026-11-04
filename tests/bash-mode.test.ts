import { describe, expect, it } from 'vitest';
import { claudeUserMessage } from '../src/engine/chat';
import { CodexAccumulator, TranscriptAccumulator } from '../src/engine/messages';
import {
  bashModeEntry,
  capOutput,
  commandAttachment,
  commandFrom,
  parseCommands,
  sizeText,
  withCommands,
  type CommandOutput,
} from '../src/shared/bash-mode';
import { compactedText } from '../src/shared/compact';

const cmd = (over: Partial<CommandOutput> = {}): CommandOutput => ({ id: 'c1', input: 'ls', stdout: 'a\nb\n', stderr: '', exitCode: 0, ...over });

describe('bash mode in the message box', () => {
  it('starts when "!" is typed or pasted into the empty box, the rest being the command line', () => {
    expect(bashModeEntry('', '!')).toBe('');
    expect(bashModeEntry('', '!git status')).toBe('git status');
    // Not in a box that holds a message, nor for a "!" later in the text.
    expect(bashModeEntry('hi', '!hi')).toBeNull();
    expect(bashModeEntry('', 'ls !')).toBeNull();
  });

  it('keeps the start and the end of output that is too long', () => {
    const long = 'x'.repeat(50) + 'y'.repeat(50);
    const cut = capOutput(long, 20);
    expect(cut).toBe(`${'x'.repeat(10)}\n… 80 characters left out …\n${'y'.repeat(10)}`);
    expect(capOutput('short', 20)).toBe('short');
  });
});

describe('the commands a message takes to the agent', () => {
  it('go ahead of its text in Claude Code’s format, a failure’s exit code and a stop as stderr’s last line', () => {
    const text = withCommands('why?', [
      commandAttachment(cmd()),
      commandAttachment(cmd({ id: 'c2', input: 'make', stdout: '', stderr: 'error\n', exitCode: 2 })),
      commandAttachment(cmd({ id: 'c3', input: 'sleep 9', stdout: '', exitCode: null, stopped: true })),
    ]);
    expect(text).toBe(
      '<bash-input>ls</bash-input>\n<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>\n\n' +
        '<bash-input>make</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>error\nExit code 2</bash-stderr>\n\n' +
        '<bash-input>sleep 9</bash-input>\n<bash-stdout></bash-stdout><bash-stderr>Stopped by the user</bash-stderr>\n\n' +
        'why?',
    );
  });

  it('give the agent a saved output’s preview and its file, in Claude Code’s <persisted-output> wording, and read back the same', () => {
    const c = cmd({ stdout: '1\n2\n', saved: { stdout: { path: '/home/me/run/commands/c1-stdout.txt', bytes: 372_224 } } });
    const text = withCommands('', [commandAttachment(c)]);
    expect(text).toBe(
      '<bash-input>ls</bash-input>\n<bash-stdout><persisted-output>\nOutput too large (363.5KB). Full output saved to: /home/me/run/commands/c1-stdout.txt\n\n' +
        'Preview (first 2KB):\n1\n2\n</persisted-output></bash-stdout><bash-stderr></bash-stderr>',
    );
    expect(parseCommands(text, 'p').commands[0]).toEqual({
      id: 'p-0',
      input: 'ls',
      stdout: '1\n2',
      stderr: '',
      exitCode: 0,
      saved: { stdout: { path: '/home/me/run/commands/c1-stdout.txt', bytes: 372_224 } },
    });
    expect([sizeText(512), sizeText(372_224), sizeText(13_002_342)]).toEqual(['512B', '363.5KB', '12.4MB']);
  });

  it('leave a message without commands as it is, and make up a message of their own', () => {
    expect(withCommands('hi', [{ name: 'a.txt', path: '/x/a.txt', image: false }])).toBe('hi');
    expect(withCommands('', [commandAttachment(cmd())])).toBe('<bash-input>ls</bash-input>\n<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>');
  });

  it('reach Claude in the message’s text, and aren’t files to read', () => {
    const msg = claudeUserMessage('see', [commandAttachment(cmd()), { name: 'n.txt', path: '/h/n.txt', image: false }], (p) => `/t${p}`);
    const content = (msg.message as { content: { type: string; text?: string }[] }).content;
    expect(content).toEqual([
      {
        type: 'text',
        text: '<bash-input>ls</bash-input>\n<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>\n\nsee\n\nAttached files (read them from these paths):\n- /t/h/n.txt',
      },
    ]);
  });

  it('go into a compacted conversation as they went to the agent', () => {
    const text = compactedText([{ id: '0', kind: 'prompt', preview: '', text: 'go', attachments: [commandAttachment(cmd())] }]);
    expect(text).toContain('[User]\n<bash-input>ls</bash-input>\n<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>\n\ngo');
    expect(text).not.toContain('Attached files');
  });

  it('come from a window checked field by field, a running one left out', () => {
    expect(commandFrom({ id: 'c1', input: 'ls', stdout: 'a', stderr: 7, exitCode: 'x', extra: true })).toEqual({ id: 'c1', input: 'ls', stdout: 'a', stderr: '', exitCode: null });
    expect(commandFrom({ id: 'c1', input: 'ls', running: true })).toBeNull();
    expect(commandFrom('ls')).toBeNull();
  });
});

describe('commands read back from a transcript', () => {
  it('parse back into the message’s commands and its text', () => {
    const message = withCommands('why?', [commandAttachment(cmd()), commandAttachment(cmd({ id: 'c2', input: 'make', stdout: '', stderr: 'error', exitCode: 2 }))]);
    const { commands, text } = parseCommands(message, 'p');
    expect(text).toBe('why?');
    expect(commands).toEqual([
      { id: 'p-0', input: 'ls', stdout: 'a\nb', stderr: '', exitCode: 0 },
      { id: 'p-1', input: 'make', stdout: '', stderr: 'error', exitCode: 2 },
    ]);
    expect(parseCommands('no commands', 'p')).toEqual({ commands: [], text: 'no commands' });
  });

  it('show as the user’s message’s attachments in a Claude Code transcript, Claude Code’s own bash mode too', () => {
    const acc = new TranscriptAccumulator();
    const user = (text: string) => JSON.stringify({ type: 'user', timestamp: '2026-11-03T10:00:00Z', message: { role: 'user', content: text } });
    acc.addLine(user(withCommands('fix it', [commandAttachment(cmd())])));
    // Claude Code's bash mode: the input, then its output as a message of its own.
    acc.addLine(user('<bash-input>git status</bash-input>'));
    acc.addLine(user('<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>'));
    const prompts = acc.rows.filter((r) => r.kind === 'prompt');
    expect(prompts.map((r) => [r.text, r.attachments?.map((a) => [a.name, a.command?.stdout])])).toEqual([
      ['fix it', [['! ls', 'a\nb']]],
      ['', [['! git status', 'clean']]],
    ]);
    expect(prompts[1].preview).toBe('! git status');
  });

  it('show as attachments in a Codex rollout', () => {
    const acc = new CodexAccumulator();
    acc.addLine(
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-03T10:00:00Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: withCommands('and now?', [commandAttachment(cmd())]) }] },
      }),
    );
    const prompt = acc.rows.find((r) => r.kind === 'prompt')!;
    expect(prompt.text).toBe('and now?');
    expect(prompt.attachments?.[0].command).toMatchObject({ input: 'ls', stdout: 'a\nb', exitCode: 0 });
  });
});
