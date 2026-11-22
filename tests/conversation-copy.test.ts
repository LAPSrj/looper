import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyConversation, copyTranscript, findConversation } from '../src/engine/conversation-copy';

const home = () => mkdtempSync(join(tmpdir(), 'looper-home-'));
const put = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

describe('a conversation copied to another harness’s folder', () => {
  it('copies a Claude Code transcript to the same project folder there, with its subagents', async () => {
    const from = home();
    const to = home();
    put(join(from, 'projects', '-w-site', 's1.jsonl'), 'a\n');
    put(join(from, 'projects', '-w-site', 's1', 'subagents', 'agent-1.jsonl'), 'sub\n');
    put(join(from, 'projects', '-w-other', 's2.jsonl'), 'other\n');
    expect(await findConversation('claude-code', from, 's1')).toBe(join(from, 'projects', '-w-site', 's1.jsonl'));
    expect(await findConversation('claude-code', from, 'nope')).toBeNull();
    await copyConversation('claude-code', 's1', from, to);
    expect(readFileSync(join(to, 'projects', '-w-site', 's1.jsonl'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(to, 'projects', '-w-site', 's1', 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('sub\n');
    expect(readdirSync(join(to, 'projects'))).toEqual(['-w-site']);
  });

  it('copies a Codex rollout to the same date folder there', async () => {
    const from = home();
    const to = home();
    const rel = join('sessions', '2026', '11', '21', 'rollout-2026-11-21T00-44-16-t1.jsonl');
    put(join(from, rel), 'r\n');
    await copyConversation('codex', 't1', from, to);
    expect(readFileSync(join(to, rel), 'utf8')).toBe('r\n');
  });

  it('replaces an older copy, and leaves a newer one and the same folder alone', async () => {
    const from = home();
    const to = home();
    const src = join(from, 'projects', '-w', 's1.jsonl');
    const dest = join(to, 'projects', '-w', 's1.jsonl');
    put(src, 'a\nb\n');
    put(dest, 'a\n');
    utimesSync(dest, new Date(1000), new Date(1000));
    await copyTranscript('claude-code', src, to);
    expect(readFileSync(dest, 'utf8')).toBe('a\nb\n');
    // The harness went on there: going back doesn't overwrite it with the older one.
    writeFileSync(dest, 'a\nb\nc\n');
    await copyTranscript('claude-code', src, to);
    expect(readFileSync(dest, 'utf8')).toBe('a\nb\nc\n');
    // Two harnesses whose folders are one (a link) share it: nothing is copied.
    const linked = home();
    symlinkSync(join(from, 'projects'), join(linked, 'projects'));
    expect(await copyTranscript('claude-code', src, linked)).toBe(join(linked, 'projects', '-w', 's1.jsonl'));
    expect(readFileSync(src, 'utf8')).toBe('a\nb\n');
  });
});
