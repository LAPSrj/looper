import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contextOfLine, readContextTokens } from '../src/engine/context';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function file(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-context-'));
  dirs.push(dir);
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

// Claude Code transcript records, in the shape claude 2.1 writes them.
const claudeResponse = (input: number, cacheRead: number, cacheWrite: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-13T10:00:00.000Z',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }],
      usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 50 },
    },
    ...extra,
  });
const claudeCompaction = (post: number | null) =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { trigger: 'auto', preTokens: 900_000, ...(post === null ? {} : { postTokens: post }) },
  });
const claudeUser = JSON.stringify({ type: 'user', message: { role: 'user', content: 'go on' } });

// Codex rollout records, as codex-cli wrote them in 2026-09 and 2026-10.
const codexCount = (input: number, cached: number) =>
  JSON.stringify({
    timestamp: '2026-10-09T18:48:30.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 50_595, cached_input_tokens: 25_344, output_tokens: 219, total_tokens: 50_814 },
        last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 98, total_tokens: input + 98 },
        model_context_window: 258_400,
      },
    },
  });
const codexCompacted = JSON.stringify({ timestamp: '2026-09-18T02:09:26.638Z', type: 'compacted', payload: { message: '' } });
const codexItem = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } });

describe('contextOfLine', () => {
  it('claude: a response counts input, cache read and cache write', () => {
    expect(contextOfLine(claudeResponse(4, 410_000, 2_000), 'claude')).toBe(412_004);
  });

  it('claude: skips user records, subagent records and synthetic messages', () => {
    expect(contextOfLine(claudeUser, 'claude')).toBeNull();
    expect(contextOfLine(claudeResponse(1, 1, 1, { isSidechain: true }), 'claude')).toBeNull();
    const synthetic = JSON.parse(claudeResponse(0, 0, 0));
    synthetic.message.model = '<synthetic>';
    expect(contextOfLine(JSON.stringify(synthetic), 'claude')).toBeNull();
  });

  it('claude: a compaction gives its size after, or unknown without one', () => {
    expect(contextOfLine(claudeCompaction(42_000), 'claude')).toBe(42_000);
    expect(contextOfLine(claudeCompaction(null), 'claude')).toBe('unknown');
  });

  it('codex: the last response input counts, cached tokens included', () => {
    expect(contextOfLine(codexCount(27_022, 22_912), 'codex')).toBe(27_022);
  });

  it('codex: a compaction and the zero count after it are unknown', () => {
    expect(contextOfLine(codexCompacted, 'codex')).toBe('unknown');
    expect(contextOfLine(codexCount(0, 0), 'codex')).toBe('unknown');
    expect(contextOfLine(codexItem, 'codex')).toBeNull();
  });

  it('a cut line says nothing', () => {
    expect(contextOfLine(claudeResponse(1, 2, 3).slice(0, 80), 'claude')).toBeNull();
  });
});

describe('readContextTokens', () => {
  it('claude: the newest response wins', async () => {
    const f = file([claudeResponse(1, 100_000, 0), claudeUser, claudeResponse(1, 300_000, 5_000), claudeUser]);
    expect(await readContextTokens(f, 'claude')).toBe(305_001);
  });

  it('claude: a compaction after the newest response wins', async () => {
    const f = file([claudeResponse(1, 800_000, 0), claudeCompaction(60_000), claudeUser]);
    expect(await readContextTokens(f, 'claude')).toBe(60_000);
  });

  it('codex: unknown right after a compaction, the next count after it', async () => {
    expect(await readContextTokens(file([codexCount(181_294, 179_968), codexCompacted, codexCount(0, 0)]), 'codex')).toBeNull();
    expect(
      await readContextTokens(file([codexCount(181_294, 179_968), codexCompacted, codexCount(0, 0), codexCount(86_069, 0), codexItem]), 'codex'),
    ).toBe(86_069);
  });

  it('reads further back when the end of a big file has no response', async () => {
    // Over 1 MB of records that say nothing after the response: three chunk sizes.
    const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(10_000) } });
    const f = file([claudeResponse(7, 200_000, 0), ...Array<string>(120).fill(filler)]);
    expect(await readContextTokens(f, 'claude')).toBe(200_007);
  });

  it('null for a transcript with no response yet', async () => {
    expect(await readContextTokens(file([claudeUser]), 'claude')).toBeNull();
  });
});
