import { describe, expect, it } from 'vitest';
import { applyModelUpdate, buildUpdateRows, type DiscoveredModel } from '../src/shared/model-update';
import { DEFAULT_MODELS } from '../src/shared/environments';

const codexCatalog: DiscoveredModel[] = [
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', main: true },
  { id: 'gpt-6.1', name: 'GPT-6.1', main: true },
];

const claudeCatalog: DiscoveredModel[] = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', main: true },
  { id: 'claude-opus-5', name: 'Claude Opus 5', main: true },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', main: true },
  { id: 'claude-fable-5', name: 'Claude Fable 5', main: false },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', main: false },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', main: true },
];

describe('buildUpdateRows', () => {
  it('codex: suggests adding new catalog models and removing delisted ones', () => {
    const rows = buildUpdateRows('codex', [{ id: 'gpt-6-astra', name: 'GPT-6-Astra' }, { id: 'gpt-5.5', name: 'GPT-5.5' }], codexCatalog);
    expect(rows.map((r) => [r.id, r.suggested])).toEqual([
      ['gpt-6-astra', 'keep'],
      ['gpt-5.5', 'remove'],
      ['gpt-6.1', 'add'],
    ]);
    expect(rows[1].supported).toBe(false);
  });

  it('never suggests removing foreign-looking ids the catalog cannot know', () => {
    const rows = buildUpdateRows('codex', [{ id: 'llama-4-70b', name: 'Llama' }], codexCatalog);
    expect(rows[0].suggested).toBe('keep');
    expect(rows[0].supported).toBe(false);
  });

  it('claude: an alias counts as its family — supported, and suppressing the add', () => {
    const rows = buildUpdateRows('claude-code', DEFAULT_MODELS['claude-code'], claudeCatalog);
    // Every alias family exists in the catalog, so nothing is added or removed.
    expect(rows.filter((r) => r.suggested !== 'keep')).toEqual([]);
    const fable = rows.find((r) => r.id === 'fable')!;
    expect(fable.supported).toBe(true);
    // Catalog models still show up as available (greyed) rows.
    expect(rows.find((r) => r.id === 'claude-fable-5-1')).toMatchObject({ inList: false, suggested: 'keep' });
  });

  it('claude: suggests main models for uncovered families and removals for dead ids', () => {
    const rows = buildUpdateRows(
      'claude-code',
      [{ id: 'claude-opus-3-9', name: 'Old Opus' }, { id: 'sonnet', name: 'Sonnet' }],
      claudeCatalog,
    );
    // opus-3-9 is family-covered (opus lives on), sonnet alias covered; fable and haiku mains get suggested.
    expect(rows.filter((r) => r.suggested === 'add').map((r) => r.id)).toEqual([
      'claude-fable-5-1',
      'claude-haiku-4-5-20251001',
    ]);
    expect(rows.find((r) => r.id === 'claude-opus-3-9')!.suggested).toBe('keep');
  });

  it('claude: a [1m] suffix does not change which model an id names', () => {
    const rows = buildUpdateRows('claude-code', [{ id: 'claude-sonnet-5[1m]', name: 'Sonnet 1M' }], claudeCatalog);
    expect(rows.find((r) => r.id === 'claude-sonnet-5[1m]')!.supported).toBe(true);
    // The bare id is already covered by its [1m] variant: no duplicate catalog row.
    expect(rows.find((r) => r.id === 'claude-sonnet-5')).toBeUndefined();
  });
});

describe('applyModelUpdate', () => {
  it('drops removals, keeps order and names, appends additions', () => {
    const current = [
      { id: 'gpt-6-astra', name: 'My Astra' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
    ];
    const rows = buildUpdateRows('codex', current, codexCatalog);
    expect(applyModelUpdate(current, rows, {})).toEqual([
      { id: 'gpt-6-astra', name: 'My Astra' },
      // Additions get an explicit default effort; kept entries are untouched.
      { id: 'gpt-6.1', name: 'GPT-6.1', defaultEffort: 'medium' },
    ]);
  });

  it('user overrides beat suggestions', () => {
    const current = [{ id: 'gpt-5.5', name: 'GPT-5.5' }];
    const rows = buildUpdateRows('codex', current, codexCatalog);
    const next = applyModelUpdate(current, rows, { 'gpt-5.5': 'keep', 'gpt-6-astra': 'add', 'gpt-6.1': 'keep' });
    expect(next).toEqual([
      { id: 'gpt-5.5', name: 'GPT-5.5' },
      { id: 'gpt-6-astra', name: 'GPT-6-Astra', defaultEffort: 'medium' },
    ]);
  });
});
