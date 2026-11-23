import type { MessageRow } from '../../../shared/messages';

/**
 * One entry of Now's list of tool calls: one of the agent's own calls (`row`), or the `index`th call a Code Mode
 * script made, read from the engine when it shows (`repl`: the script's REPL call).
 */
export type NowEntry = { row: MessageRow; repl?: undefined; index?: undefined } | { row?: undefined; repl: MessageRow; index: number };

/**
 * The tool calls of a conversation's rows that Now lists as the agent's own. A file a Code Mode script sent is listed
 * as the script's call it was (its REPL call's `calls`), except in a compacted conversation's session whose REPL
 * calls don't keep their scripts' calls (a compacted.json from before version 4): there the sent file is listed, as
 * the script's (entryFromScript).
 */
export function nowTools(rows: readonly MessageRow[]): MessageRow[] {
  const scripted = new Set<number>();
  for (const r of rows) if (r.layer !== undefined && r.tool === 'REPL' && r.calls) scripted.add(r.layer);
  return rows.filter((r) => r.kind === 'tool' && (!r.fromScript || (r.layer !== undefined && !scripted.has(r.layer))));
}

/** A Code Mode script made the entry's call: its title says so. */
export const entryFromScript = (e: NowEntry): boolean => !e.row || !!e.row.fromScript;

/** An entry's key in the list: a row's id, or a script call's REPL call and place in its script. */
export const entryKey = (e: NowEntry): string => (e.row ? e.row.id : `${e.repl.id}#${e.index}`);

/**
 * Every tool call Now steps through, in the order they ran: the agent's own calls (`tools`), each followed by the
 * calls scripts made after it and before the agent's next one (MessageRow.calls.at), those of scripts running at once
 * in the order they were made. A REPL row whose calls have no place (`at`) has them right after it.
 */
export function nowEntries(tools: readonly MessageRow[]): NowEntry[] {
  const after = new Map<number, { seq: number; order: number; entry: NowEntry }[]>();
  let order = 0;
  tools.forEach((t, j) => {
    const calls = t.toolUseId ? t.calls : undefined;
    if (!calls?.count) return;
    let index = 0;
    const place = (anchor: number, seq: number) => {
      const list = after.get(anchor) ?? [];
      list.push({ seq, order: order++, entry: { repl: t, index: index++ } });
      after.set(anchor, list);
    };
    for (const [skip, seq, n] of calls.at ?? []) for (let k = 0; k < n && index < calls.count; k++) place(Math.min(j + skip, tools.length - 1), seq + k);
    while (index < calls.count) place(j, Number.POSITIVE_INFINITY);
  });
  const out: NowEntry[] = [];
  tools.forEach((t, j) => {
    out.push({ row: t });
    const list = after.get(j);
    if (!list) return;
    // Infinity - Infinity is NaN, which || passes on to the order they were placed in.
    list.sort((a, b) => a.seq - b.seq || a.order - b.order);
    for (const x of list) out.push(x.entry);
  });
  return out;
}
