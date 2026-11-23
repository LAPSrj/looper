import { readFileSync } from 'node:fs';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { rowSignature } from '../src/shared/chat-delta';
import { briefRow, type MessageRow } from '../src/shared/messages';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe("Now's list of tool calls", () => {
  const panel = read('src/renderer/src/components/ActivityPanel.tsx');

  it("has no second panel of a script's calls under a REPL call's screen: they are Now's entries", () => {
    expect(panel).not.toMatch(/ScriptCallBox|ScriptNow|ScriptCallRows|now-script/);
    expect(panel).toContain('nowEntries(tools)');
    // "n of m", Previous and Next count every entry.
    expect(panel).toContain('status={`${i + 1} of ${entries.length}`}');
    expect(panel).toMatch(/enabled: i < entries\.length - 1/);
  });

  it('titles a call a script made "[REPL] " as plain text, not a badge', () => {
    expect(panel).toContain("const SCRIPT_CALL_PREFIX = '[REPL] ';");
    expect(panel).not.toMatch(/className=\{?["'`][^"'`]*(badge|pill|chip)/);
  });

  it('draws only the rows in view of a long list, its rows of one height', () => {
    expect(panel).toMatch(/<RowList[\s\S]*?\bwindowed\b[\s\S]*?label="Tool calls"/);
    // A phone's row has its second line even before its call is read.
    expect(panel).toMatch(/sub: subject \|\| '/);
  });
});

describe('RowList with windowed', () => {
  // The desktop app's page: its preload's window.looper, and the root element the platform is set on.
  // Read by its path at run time: the tests' type check (tsconfig.node.json) doesn't take the renderer's JSX.
  const ROW_LIST = '../src/renderer/src/components/RowList';
  let RowList: FunctionComponent<Record<string, unknown>>;
  beforeAll(async () => {
    const element = { dataset: {}, classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined, contains: () => false }, style: {} };
    Object.assign(globalThis, { window: { looper: {}, addEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined }) }, document: { documentElement: element, addEventListener: () => undefined } });
    ({ RowList } = (await import(/* @vite-ignore */ ROW_LIST)) as { RowList: typeof RowList });
  });
  const rows = Array.from({ length: 1000 }, (_, i) => String(i));
  const list = (windowed: boolean) =>
    renderToStaticMarkup(
      createElement(RowList, {
        rows,
        rowKey: (r: string) => r,
        idPrefix: 'r',
        empty: null,
        listClass: 'l',
        rowClass: 'row',
        windowed,
        row: (r: string) => r,
        phoneRow: (r: string) => ({ title: r }),
      }),
    );
  const drawn = (html: string) => html.match(/role="option"/g)?.length ?? 0;

  it('draws a screen of rows and their overscan past 200 rows, and keeps the height of the rest', () => {
    const html = list(true);
    expect(drawn(html)).toBeGreaterThan(20);
    expect(drawn(html)).toBeLessThan(200);
    // The rows not drawn take their height below them, and never anchor the scroll (a jump to the end stays there).
    expect(html).toMatch(/<div aria-hidden="true" style="height:\d{4,}px;overflow-anchor:none"><\/div><\/div>$/);
  });

  it('draws every row without it', () => {
    expect(drawn(list(false))).toBe(1000);
  });
});

describe("a script's call as a list reads it (briefRow)", () => {
  const call: MessageRow = {
    id: '7',
    kind: 'tool',
    tool: 'Bash',
    preview: 'Build it',
    text: 'command:\nnpm run build\nnpm test',
    input: { command: 'npm run build\nnpm test', description: 'Build it', env: { big: 'x'.repeat(2000) } },
    result: 'x'.repeat(50_000),
    resultError: true,
    toolUseId: 'toolu_1',
    logs: 'log',
  };

  it("keeps the title's fields and the call's state, without its input's text, result or logs", () => {
    const b = briefRow(call);
    expect(b).toMatchObject({ id: '7', tool: 'Bash', preview: 'Build it', toolUseId: 'toolu_1', resultError: true, result: '', text: '' });
    expect(b.input).toEqual({ command: 'npm run build', description: 'Build it' });
    expect(b.logs).toBeUndefined();
    expect(JSON.stringify(b).length).toBeLessThan(400);
  });

  it('keeps a running call running', () => {
    expect(briefRow({ ...call, result: undefined }).result).toBeUndefined();
  });
});

describe("a REPL call's place among the agent's calls in a streaming chat", () => {
  it('sends the row again when where its calls ran changes', () => {
    const repl: MessageRow = { id: '1', kind: 'tool', tool: 'REPL', preview: '', text: '', calls: { count: 2, failed: 0, at: [[0, 0, 2]] } };
    expect(rowSignature(repl)).not.toBe(rowSignature({ ...repl, calls: { count: 2, failed: 0, at: [[0, 0, 1], [1, 1, 1]] } }));
  });
});
