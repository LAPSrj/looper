import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeModelWindows, ModelWindows } from '../src/engine/model-windows';

describe('context windows from result records', () => {
  it("reads every model's window from claude's result, by the id without its window suffix", () => {
    const result = { type: 'result', modelUsage: { 'claude-sonnet-5-5[1m]': { contextWindow: 1_000_000 }, 'claude-haiku-5-5': { contextWindow: 200_000 }, x: {} } };
    expect(claudeModelWindows(result)).toEqual({ 'claude-sonnet-5-5': 1_000_000, 'claude-haiku-5-5': 200_000 });
    expect(claudeModelWindows({ type: 'result' })).toEqual({});
  });

  it("keeps every window a model ran with, and picks the smallest that holds the context (else the largest)", () => {
    const store = new ModelWindows();
    store.learn({ 'claude-sonnet-5-5': 1_000_000 });
    store.learn({ 'claude-sonnet-5-5': 200_000 });
    expect(store.pick('claude-sonnet-5-5', 50_000)).toBe(200_000);
    expect(store.pick('claude-sonnet-5-5[1m]', 350_000)).toBe(1_000_000);
    expect(store.pick('claude-sonnet-5-5', 2_000_000)).toBe(1_000_000);
    expect(store.pick('claude-haiku-5-5', 1)).toBeUndefined();
  });

  it('saves them when one is new and reads them back at the next start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'looper-windows-'));
    const file = path.join(dir, 'model-windows.json');
    try {
      const store = new ModelWindows();
      store.open(file);
      expect(fs.existsSync(file)).toBe(false);
      store.learn({ 'claude-haiku-5-5': 200_000 });
      const written = fs.statSync(file).mtimeMs;
      store.learn({ 'claude-haiku-5-5': 200_000 });
      expect(fs.statSync(file).mtimeMs).toBe(written);
      const again = new ModelWindows();
      again.open(file);
      expect(again.pick('claude-haiku-5-5', 10)).toBe(200_000);
      fs.writeFileSync(file, '{"m": ["x", -1], "n": 5}');
      again.open(file);
      expect(again.pick('m', 1)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
