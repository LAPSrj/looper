import { useEffect, useMemo, useState } from 'react';
import type { Environment } from '@shared/types';
import { definitionFields, fileName, lineDiff, type DiffLine, type VersionDetail } from '@shared/versions';
import { DataTable, type DataCol } from './components/DataTable';
import { ListDetail, selectsFirstRow } from './components/ListDetail';
import { CodeBlock, TextDiff } from './components/ToolContent';
import { EmptyWindow } from './components/ui';
import { WindowActions } from './components/WindowActions';
import { settingGroup, settingLabel, settingValue } from './taskSettings';
import { subscribe } from './events';

/** A text's lines: a file's final newline ends its last line, it isn't one more empty line. */
const linesOf = (text: string) => text.replace(/\n$/, '').split('\n');

/** Both sides' line diff; a side that's null (not set, no file) has no lines. */
function diffLines(a: string | null, b: string | null): DiffLine[] {
  if (a === null || b === null) return linesOf(a ?? b ?? '').map((text) => ({ op: a === null ? '+' : '-', text }));
  return lineDiff(a.replace(/\n$/, ''), b.replace(/\n$/, ''));
}

/** One difference in the list: a field or a file, with both sides as text (null = not set / no file). */
interface Difference {
  key: string;
  name: string;
  title: string;
  /** The list's one-line summaries. */
  a: string;
  b: string;
  /** The full values for the side-by-side view. */
  textA: string | null;
  textB: string | null;
}

const fullText = (v: unknown): string | null =>
  v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v, null, 2);

type Rec = Record<string, unknown>;

/** One line for the list: the value in the editor's words, or its first line. */
function summary(path: string, v: unknown, def: Rec, environments: Environment[]): string {
  const short = settingValue(path, v, def, environments);
  if (short !== undefined) return short;
  const first = (fullText(v) ?? '').split('\n').find((l) => l.trim()) ?? '';
  return `${first.trim()} …`;
}

function fileSummary(text: string | null): string {
  if (text === null) return 'No file';
  const lines = text.replace(/\n$/, '').split('\n').length;
  return lines === 1 ? '1 line' : `${lines} lines`;
}

/** A value in full for the pane below the list: one-line values in words, the rest as they are. */
function paneText(path: string, v: unknown, def: Rec, environments: Environment[]): string | null {
  if (v === undefined) return null;
  return settingValue(path, v, def, environments) ?? fullText(v);
}

function differencesOf(detail: VersionDetail, environments: Environment[]): Difference[] {
  // Ids (harness, model) read as names through each side's own definition.
  const defA = detail.task as unknown as Rec;
  const defB = (detail.current ?? detail.task) as unknown as Rec;
  const fields: Difference[] = (detail.diff ?? []).map((d) => ({
    key: d.path,
    name: settingLabel(d.path),
    title: d.path,
    a: summary(d.path, d.a, defA, environments),
    b: summary(d.path, d.b, defB, environments),
    textA: paneText(d.path, d.a, defA, environments),
    textB: paneText(d.path, d.b, defB, environments),
  }));
  const files: Difference[] = (detail.fileDiff ?? []).map((f) => ({
    key: `file:${f.path}`,
    name: fileName(f.path),
    title: f.path,
    a: fileSummary(f.a),
    b: fileSummary(f.b),
    textA: f.a,
    textB: f.b,
  }));
  return [...fields, ...files];
}

/** The selected difference, with line numbers and the changed lines marked. */
function DifferenceView({ d, n }: { d: Difference; n: number }) {
  const lines = useMemo(() => diffLines(d.textA, d.textB), [d.textA, d.textB]);
  const file = d.key.startsWith('file:') ? d.title : undefined;
  return <TextDiff lines={lines} titles={[`Version ${n}`, 'Current']} missing={[d.textA === null, d.textB === null]} placeholder={file ? 'No file' : 'Not set'} file={file} />;
}

/** Compare: the differences from the current version as a list, the selected one side by side underneath. */
function CompareView({ detail, n, environments }: { detail: VersionDetail; n: number; environments: Environment[] }) {
  const diffs = differencesOf(detail, environments);
  const [selected, setSelected] = useState<string | null>(null);
  const current = diffs.find((d) => d.key === selected) ?? (selectsFirstRow ? diffs[0] : undefined);

  if (diffs.length === 0) {
    return <div className="compare-same">Version {n} is the same as the current version.</div>;
  }
  type Diff = (typeof diffs)[number];
  const cols: DataCol<Diff>[] = [
    { label: 'Name', percent: 28, cell: (d) => d.name, title: (d) => d.title },
    { label: `Version ${n}`, cell: (d) => d.a, title: (d) => d.a },
    { label: 'Current', cell: (d) => d.b, title: (d) => d.b },
  ];
  return (
    <ListDetail
      panes={{ axis: 'y', initial: 34, unit: '%', min: 15, max: 85 }}
      open={selected !== null}
      onClose={() => setSelected(null)}
      detailTitle={current?.name}
      empty="Select a difference"
      list={
        <DataTable
          wrapClass="runlog-table-wrap compare-list"
          cols={cols}
          rows={diffs}
          rowKey={(d) => d.key}
          idPrefix="compare"
          selected={current?.key}
          onSelect={(d) => setSelected(d.key)}
          empty={null}
          phoneRow={(d) => ({ title: d.name, sub: `${d.a} → ${d.b}` })}
        />
      }
      detail={<div className="compare-pane">{current && <DifferenceView d={current} n={n} />}</div>}
    />
  );
}

/** One item of a version: a setting or a file, with its one-line summary and its full text (null = not set / no file). */
interface Item {
  key: string;
  group: string;
  name: string;
  title: string;
  value: string;
  text: string | null;
  missing: string;
}

const VIEW_COLS: readonly DataCol<Item>[] = [
  { label: 'Name', percent: 28, cell: (i) => i.name, title: (i) => i.title },
  { label: 'Value', cell: (i) => i.value, title: (i) => i.value },
];

const GROUP_ORDER = ['General', 'Trigger', 'Check', 'Classifier', 'Agent', 'Notifications', 'Files'];

function itemsOf(detail: VersionDetail, environments: Environment[]): Item[] {
  const def = detail.task as unknown as Rec;
  const fields: Item[] = definitionFields(detail.task).map(({ path, value }) => ({
    key: path,
    group: settingGroup(path),
    name: settingLabel(path),
    title: path,
    value: summary(path, value, def, environments),
    text: paneText(path, value, def, environments),
    missing: 'Not set',
  }));
  // A file the version recorded as missing is no file of this version.
  const files: Item[] = detail.files
    .filter((f) => f.content !== null)
    .map((f) => ({
      key: `file:${f.path}`,
      group: 'Files',
      name: fileName(f.path),
      title: f.path,
      value: fileSummary(f.content) + (f.matchesDisk === false ? ' · the file on disk is different now' : ''),
      text: f.content,
      missing: 'No file',
    }));
  return [...fields, ...files].sort((x, y) => GROUP_ORDER.indexOf(x.group) - GROUP_ORDER.indexOf(y.group));
}

/** The selected item in full, with line numbers, a file in its language's colors. */
function TextView({ item }: { item: Item }) {
  if (item.text === null) return <div className="muted compare-missing">{item.missing}</div>;
  return <CodeBlock text={item.text} file={item.key.startsWith('file:') ? item.title : undefined} caption={{ text: item.name, title: item.title }} />;
}

/** View: the version's settings and files as a list, the selected one in full underneath. */
function VersionView({ detail, environments }: { detail: VersionDetail; environments: Environment[] }) {
  const items = itemsOf(detail, environments);
  const [selected, setSelected] = useState<string | null>(null);
  const current = items.find((i) => i.key === selected) ?? (selectsFirstRow ? items[0] : undefined);
  if (items.length === 0) return <div className="compare-same">This version has no settings.</div>;
  return (
    <ListDetail
      panes={{ axis: 'y', initial: 50, unit: '%', min: 15, max: 85 }}
      open={selected !== null}
      onClose={() => setSelected(null)}
      detailTitle={current?.name}
      empty="Select a setting"
      list={
        <DataTable
          wrapClass="runlog-table-wrap compare-list"
          cols={VIEW_COLS}
          rows={items}
          rowKey={(i) => i.key}
          idPrefix="setting"
          selected={current?.key}
          onSelect={(i) => setSelected(i.key)}
          empty={null}
          groupOf={(i) => i.group}
          phoneRow={(i) => ({ title: i.name, sub: i.value })}
        />
      }
      detail={<div className="compare-pane">{current && <TextView item={current} />}</div>}
    />
  );
}

/** A version's own window: its definition and files (View), or how it differs from the current version (Compare). */
export function VersionDetailApp({ taskId, n, compare }: { taskId: string; n: number; compare: boolean }) {
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);

  useEffect(() => {
    void window.looper.info().then((i) => setEnvironments(i.settings.environments));
  }, []);

  useEffect(() => {
    document.title = compare ? `Compare Version ${n} with Current` : `Version ${n}`;
    const load = () =>
      void window.looper.versions
        .detail(taskId, n, compare)
        .then(setDetail)
        .catch((e: Error) => setError(e.message));
    load();
    // Compare follows the current task as it changes.
    return subscribe((e) => {
      if ((e.type === 'versions' && e.taskId === taskId) || e.type === 'tasks') load();
    });
  }, [taskId, n, compare]);

  const restore = async () => {
    if (!(await window.looper.confirm(`Restore version ${n}? Its definition and recorded files replace the current ones, and the restore is saved as a new version.`))) return;
    try {
      await window.looper.versions.restore(taskId, n);
      window.close();
    } catch (e) {
      void window.looper.showError((e as Error).message);
    }
  };

  if (error || !detail) return <EmptyWindow gone={error} />;
  return (
    <div className="editor">
      <div className="editor-body compare-app">
        {compare ? (
          <CompareView detail={detail} n={n} environments={environments} />
        ) : (
          <VersionView detail={detail} environments={environments} />
        )}
      </div>
      <WindowActions close extras={[{ id: 'restore', label: 'Restore', disabled: detail.isCurrent, run: () => void restore() }]} />
    </div>
  );
}
