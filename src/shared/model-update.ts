import type { Harness, HarnessModel } from './types';

/**
 * One entry of a harness kind's live model catalog, as discovered from the
 * CLI (`codex debug models`) or the API (`GET /v1/models` for claude-code).
 */
export interface DiscoveredModel {
  id: string;
  name: string;
  /** Belongs in the default picker: codex list-visible, claude newest per family. */
  main: boolean;
}

export type ModelAction = 'add' | 'remove' | 'keep';

/** One row of the Update Models window: a current or discoverable model. */
export interface ModelUpdateRow {
  id: string;
  name: string;
  /** Currently in the harness's model list. */
  inList: boolean;
  /** Still offered per the discovered catalog (family-aware for claude aliases). */
  supported: boolean;
  main: boolean;
  /** Preselected action: add new main models, remove delisted ones, keep the rest. */
  suggested: ModelAction;
}

const CLAUDE_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

/** Context-window suffixes (`[1m]`) don't change which model an id names. */
function bareId(id: string): string {
  return id.replace(/\[\w+\]$/, '').trim();
}

/** The claude family an id belongs to: a bare alias ('opus') or a full id ('claude-opus-5'). */
function claudeFamily(id: string): string | undefined {
  const bare = bareId(id);
  if (CLAUDE_FAMILIES.includes(bare)) return bare;
  const m = /^claude-([a-z]+)/.exec(bare);
  return m && CLAUDE_FAMILIES.includes(m[1]) ? m[1] : undefined;
}

/**
 * Whether an id looks like it names one of the harness's own models. Foreign
 * ids (a Bedrock ARN, a proxy's model) are never in the catalog, so absence
 * proves nothing about them — they never get a remove suggestion.
 */
function nativeId(kind: Harness['kind'], id: string): boolean {
  if (kind === 'claude-code') return claudeFamily(id) !== undefined || /^claude/.test(bareId(id));
  if (kind === 'codex') return /^(gpt|codex|o\d)/i.test(bareId(id));
  return false;
}

/**
 * Diff a harness's current model list against its discovered catalog. Rows
 * come out in resulting-list order: current entries first (their order kept),
 * then the catalog models not in the list (catalog order). Existing entries
 * are never renamed; a family already in the list (e.g. the 'opus' alias)
 * counts as supported and suppresses the add suggestion for that family.
 */
export function buildUpdateRows(
  kind: Harness['kind'],
  current: HarnessModel[],
  catalog: DiscoveredModel[],
): ModelUpdateRow[] {
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const catalogFamilies = new Set(kind === 'claude-code' ? catalog.map((m) => claudeFamily(m.id)) : []);
  const listIds = new Set(current.map((m) => bareId(m.id)));
  const listFamilies = new Set(kind === 'claude-code' ? current.map((m) => claudeFamily(m.id)) : []);

  const rows: ModelUpdateRow[] = current.map((m) => {
    const family = kind === 'claude-code' ? claudeFamily(m.id) : undefined;
    const supported = byId.has(bareId(m.id)) || (family !== undefined && catalogFamilies.has(family));
    return {
      id: m.id,
      name: m.name,
      inList: true,
      supported,
      main: byId.get(bareId(m.id))?.main ?? false,
      suggested: !supported && nativeId(kind, m.id) ? 'remove' : 'keep',
    };
  });
  for (const m of catalog) {
    if (listIds.has(m.id)) continue;
    const family = kind === 'claude-code' ? claudeFamily(m.id) : undefined;
    const familyCovered = family !== undefined && listFamilies.has(family);
    rows.push({
      id: m.id,
      name: m.name,
      inList: false,
      supported: true,
      main: m.main,
      suggested: m.main && !familyCovered ? 'add' : 'keep',
    });
  }
  return rows;
}

/**
 * The model list after the chosen actions: kept current entries in their
 * order (names untouched), then the added catalog entries in row order.
 * Actions default to each row's suggestion.
 */
export function applyModelUpdate(
  current: HarnessModel[],
  rows: ModelUpdateRow[],
  actions: Record<string, ModelAction>,
): HarnessModel[] {
  const action = (row: ModelUpdateRow) => actions[row.id] ?? row.suggested;
  const removed = new Set(rows.filter((r) => r.inList && action(r) === 'remove').map((r) => r.id));
  const next = current.filter((m) => !removed.has(m.id));
  for (const r of rows) {
    // Added entries get an explicit default effort, keeping runs on them
    // predictable instead of inheriting the CLI's own effort state.
    if (!r.inList && action(r) === 'add') next.push({ id: r.id, name: r.name, defaultEffort: 'medium' });
  }
  return next;
}
