import type { ReactNode } from 'react';
import type { MessageRow, PatchHunk } from '@shared/messages';
import { stripAnsi } from '../format';
import { MessageBody, parseTagSections, TagSections } from './Markdown';

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const inputOf = (row: MessageRow): Rec | null =>
  row.input !== null && typeof row.input === 'object' && !Array.isArray(row.input) ? (row.input as Rec) : null;

/** Fields already shown by a custom render; anything else still gets listed. */
function restFields(input: Rec, shown: string[]): ReactNode {
  const rest = Object.entries(input).filter(([k]) => !shown.includes(k));
  if (rest.length === 0) return null;
  return (
    <div className="tc-fields">
      {rest.map(([k, v]) => (
        <div key={k}>
          {k}: {typeof v === 'string' ? v : JSON.stringify(v)}
        </div>
      ))}
    </div>
  );
}

/* ---------- Diff ---------- */

function DiffView({ hunks }: { hunks: PatchHunk[] }) {
  return (
    <div className="diff">
      {hunks.map((h, i) => (
        <div key={i}>
          <div className="diff-hunk-header">{`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`}</div>
          {h.lines.map((line, j) => {
            const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
            return (
              <div key={j} className={`diff-line diff-${kind}`}>
                {line || ' '}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Before the harness records a patch: the replaced block and its replacement. */
function OldNewDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const block = (text: string, kind: 'del' | 'add') =>
    text.split('\n').map((line, i) => (
      <div key={i} className={`diff-line diff-${kind}`}>
        {(kind === 'del' ? '-' : '+') + line}
      </div>
    ));
  return (
    <div className="diff">
      {block(oldText, 'del')}
      {block(newText, 'add')}
    </div>
  );
}

/* ---------- Read result: line-number gutter ---------- */

const GUTTER_RE = /^\s*(\d+)→(.*)$/;

function gutterLines(text: string): { n: string; text: string }[] | null {
  const lines = text.split('\n');
  const parsed: { n: string; text: string }[] = [];
  let matched = 0;
  for (const line of lines) {
    const m = GUTTER_RE.exec(line);
    if (m) {
      matched++;
      parsed.push({ n: m[1], text: m[2] });
    } else {
      parsed.push({ n: '', text: line });
    }
  }
  return matched >= lines.length * 0.6 ? parsed : null;
}

function CodeView({ lines }: { lines: { n: string; text: string }[] }) {
  return (
    <div className="code-view">
      {lines.map((l, i) => (
        <div key={i} className="code-line">
          <span className="code-gutter">{l.n}</span>
          <span className="code-text">{l.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- JSON tree ---------- */

const MAX_TREE_ENTRIES = 200;
const MAX_LEAF_CHARS = 2000;

function JsonNode({ k, value, depth }: { k?: string; value: unknown; depth: number }) {
  const label = k === undefined ? '' : `${k}: `;
  if (value === null || typeof value !== 'object') {
    let text = typeof value === 'string' ? JSON.stringify(value) : String(value);
    if (text.length > MAX_LEAF_CHARS) text = text.slice(0, MAX_LEAF_CHARS) + '…';
    return (
      <div className="json-leaf">
        {label}
        {text}
      </div>
    );
  }
  const isArr = Array.isArray(value);
  const entries = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Rec);
  const capped = entries.slice(0, MAX_TREE_ENTRIES);
  return (
    <details className="json-node" open={depth < 2}>
      <summary>
        {label}
        {isArr ? `[${entries.length}]` : `{${entries.length}}`}
      </summary>
      <div className="json-children">
        {capped.map(([key, v]) => (
          <JsonNode key={key} k={key} value={v} depth={depth + 1} />
        ))}
        {entries.length > capped.length && <div className="json-leaf muted">… {entries.length - capped.length} more</div>}
      </div>
    </details>
  );
}

const jsonTree = (value: unknown) => (
  <div className="json-tree">
    <JsonNode value={value} depth={0} />
  </div>
);

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

/* ---------- File lists ---------- */

const PATH_RE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)\S.*$/;

interface FileCtx {
  taskId: string;
  runId: string;
}

function FileList({ files, ctx }: { files: string[]; ctx: FileCtx }) {
  return (
    <div className="file-list">
      {files.map((f, i) => (
        <div
          key={i}
          className="file-list-item"
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            window.looper.showMessageContextMenu({ taskId: ctx.taskId, runId: ctx.runId, file: f, text: f });
          }}
        >
          {f}
        </div>
      ))}
    </div>
  );
}

/** Grep/Glob output as a right-clickable file list, when it is one path per line. */
function pathList(text: string): string[] | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 2000) return null;
  return lines.every((l) => PATH_RE.test(l)) ? lines : null;
}

/* ---------- Shared blocks ---------- */

const plain = (text: string | undefined) => <pre className="output">{text}</pre>;

function fileHeader(file: string | undefined): ReactNode {
  return file ? <div className="tc-file mono">{file}</div> : null;
}

/* ---------- Input renders ---------- */

function bashInput(input: Rec): ReactNode {
  const description = str(input.description);
  return (
    <>
      {description && <div className="tc-caption muted">{description}</div>}
      <pre className="term-block">{str(input.command) ?? ''}</pre>
      {restFields(input, ['command', 'description'])}
    </>
  );
}

function editInput(row: MessageRow, input: Rec): ReactNode {
  const oldText = str(input.old_string) ?? '';
  const newText = str(input.new_string) ?? '';
  return (
    <>
      {fileHeader(row.file)}
      {input.replace_all === true && <div className="tc-caption muted">Replaces all occurrences</div>}
      {row.patch ? <DiffView hunks={row.patch} /> : <OldNewDiff oldText={oldText} newText={newText} />}
    </>
  );
}

function writeInput(row: MessageRow, input: Rec): ReactNode {
  return (
    <>
      {fileHeader(row.file)}
      <pre className="output">{str(input.content) ?? ''}</pre>
    </>
  );
}

function taskInput(input: Rec): ReactNode {
  const description = str(input.description);
  return (
    <>
      {description && <div className="tc-heading">{description}</div>}
      {restFields(input, ['description', 'prompt'])}
      <MessageBody text={str(input.prompt) ?? ''} />
    </>
  );
}

interface Todo {
  content: string;
  status: string;
}

function todoInput(input: Rec): ReactNode {
  const todos = Array.isArray(input.todos)
    ? (input.todos as Rec[]).filter((t) => t && typeof t.content === 'string')
    : [];
  if (todos.length === 0) return plain(JSON.stringify(input, null, 2));
  const mark = (status: unknown) => (status === 'completed' ? '✓' : status === 'in_progress' ? '●' : '○');
  return (
    <div className="todo-list">
      {(todos as unknown as Todo[]).map((t, i) => (
        <div key={i} className={`todo-item${t.status === 'completed' ? ' done' : ''}`}>
          <span className="todo-mark">{mark(t.status)}</span>
          {t.content}
        </div>
      ))}
    </div>
  );
}

function webInput(input: Rec): ReactNode {
  const url = str(input.url);
  return (
    <div className="tc-web">
      {url && (
        <div className="tc-fields">
          <a href={url} target="_blank" rel="noreferrer">
            {url}
          </a>
        </div>
      )}
      {str(input.query) && <div className="tc-fields">query: {str(input.query)}</div>}
      {str(input.prompt) && <MessageBody text={input.prompt as string} />}
      {restFields(input, ['url', 'query', 'prompt'])}
    </div>
  );
}

export function ToolInputView({ row }: { row: MessageRow }) {
  const input = inputOf(row);
  if (!input) return plain(row.text);
  switch (row.tool) {
    case 'Bash':
      return <>{bashInput(input)}</>;
    case 'Edit':
      return <>{editInput(row, input)}</>;
    case 'Write':
      return <>{writeInput(row, input)}</>;
    case 'Task':
    case 'Agent':
      return <>{taskInput(input)}</>;
    case 'TodoWrite':
      return <>{todoInput(input)}</>;
    case 'WebFetch':
    case 'WebSearch':
      return <>{webInput(input)}</>;
    default:
      return plain(row.text);
  }
}

/* ---------- Result renders ---------- */

export function ToolResultView({ row, ctx }: { row: MessageRow; ctx: FileCtx }) {
  const result = row.result ?? '';
  switch (row.tool) {
    case 'Task':
    case 'Agent':
      return <MessageBody text={result} />;
    case 'Bash': {
      const text = stripAnsi(result);
      const parsed = parseJson(text);
      return parsed !== undefined ? jsonTree(parsed) : plain(text);
    }
    case 'Read': {
      const lines = gutterLines(result);
      return lines ? <CodeView lines={lines} /> : plain(result);
    }
    case 'Grep':
    case 'Glob': {
      const files = pathList(result);
      return files ? <FileList files={files} ctx={ctx} /> : plain(result);
    }
    case 'WebFetch':
    case 'WebSearch':
      return <MessageBody text={result} />;
    default: {
      // TaskOutput-style results arrive fully tag-wrapped; their content is
      // plain terminal text, so section bodies stay monospace.
      const sections = parseTagSections(result);
      if (sections) return <TagSections sections={sections} mono />;
      const parsed = parseJson(result);
      if (parsed !== undefined) {
        const files = (parsed as Rec | null)?.files;
        if (Array.isArray(files) && files.length > 0 && files.every((f) => typeof f === 'string')) {
          return <FileList files={files as string[]} ctx={ctx} />;
        }
        return jsonTree(parsed);
      }
      return plain(result);
    }
  }
}
