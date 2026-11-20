import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseInspected } from '../src/shared/inspect';

describe("a Code Mode script's result, as util.inspect prints it", () => {
  it('reads back what util.inspect printed', () => {
    const values: unknown[] = [
      { total: 120, slow: [['billing.json', 45000], ['exports.json', 60000]], ok: true, none: null },
      [1, -2.5, 3e21, 'it\'s "quoted"\nover two lines'],
      { 'needs-quotes': 'a', nested: { deep: ['x'] } },
      'just text\nwith a line break',
      42,
      { long: 'word '.repeat(60) },
    ];
    for (const v of values) expect(parseInspected(inspect(v))).toEqual({ value: v });
  });

  it('keeps what it can only name as text, and reads Maps, Sets and dates', () => {
    const fn = function load() {};
    expect(parseInspected(inspect({ fn, deep: { a: { b: { c: { d: 1 } } } } }))).toEqual({ value: { fn: '[Function: load]', deep: { a: { b: '[Object]' } } } });
    expect(parseInspected(inspect(new Map([['a', 1]])))).toEqual({ value: { a: 1 } });
    expect(parseInspected(inspect(new Set([1, 2])))).toEqual({ value: [1, 2] });
    expect(parseInspected(inspect(new Date('2026-11-19T10:00:00.000Z')))).toEqual({ value: '2026-11-19T10:00:00.000Z' });
    expect(parseInspected(inspect(Array.from({ length: 120 }, (_, n) => n)))?.value).toContain('... 20 more items');
    expect(parseInspected(inspect(undefined))).toEqual({ value: undefined });
  });

  it('reads JSON too, and nothing that isnt one value', () => {
    expect(parseInspected('{"a": [1, 2], "b": "c"}')).toEqual({ value: { a: [1, 2], b: 'c' } });
    expect(parseInspected('Error: ENOENT: no such file\n    at open (node:fs:1:1)')).toBeNull();
    expect(parseInspected('{ a: 1 } trailing')).toBeNull();
    expect(parseInspected('(dispatched #3)')).toBeNull();
  });
});
