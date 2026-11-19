import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useThumbnail } from './hooks';
import { toolImageKey, type MessageRow, type PatchHunk } from '@shared/messages';
import { stripAnsi } from '../format';
import { isPhone } from '../web/page-nav';
import { escapeHtml, hunkRows, lineDiffRows, markRanges, replacedRows, type DiffRow } from './editor-lines';
import { Markdown, MessageBody, parseTagSections, TagSections } from './Markdown';

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const inputOf = (row: MessageRow): Rec | null =>
  row.input !== null && typeof row.input === 'object' && !Array.isArray(row.input) ? (row.input as Rec) : null;

const valueText = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? String(v)));

/** The parameters that hold code, by tool, and the language each is written in. */
const CODE_PARAMS: Record<string, Record<string, string>> = {
  Workflow: { script: 'javascript' },
  Bash: { command: 'bash' },
  PowerShell: { command: 'powershell' },
};

/**
 * A call's parameters as a table: names in the first column, and every value
 * starting at the same place. A parameter named in `code` (parameter name to
 * language) is highlighted code that scrolls sideways instead of wrapping.
 */
export function ParamTable({ entries, code }: { entries: [string, unknown][]; code?: Record<string, string> }) {
  if (entries.length === 0) return null;
  return (
    <table className="tc-params">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            {code?.[k] && typeof v === 'string' ? (
              <td className="has-code">
                <div className="tc-code">
                  <CodeBlock text={v} language={code[k]} />
                </div>
              </td>
            ) : (
              <td>{valueText(v)}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Fields already shown by a custom render; anything else still gets listed. */
function restFields(input: Rec, shown: string[]): ReactNode {
  return <ParamTable entries={Object.entries(input).filter(([k]) => !shown.includes(k))} />;
}

/* ---------- Syntax highlighting ---------- */

type Highlighter = typeof import('./highlight');
let highlighter: Highlighter | null = null;
let loadingHighlighter: Promise<Highlighter> | null = null;

/**
 * The lines as highlighted HTML, colored for the file's language (or the
 * `language` given); null while the highlighter loads, or for a language it
 * doesn't know. The highlighter loads on first use.
 */
export function useHighlight(lines: string[], file?: string, language?: string): string[] | null {
  const [mod, setMod] = useState(highlighter);
  useEffect(() => {
    if (mod) return;
    let live = true;
    void (loadingHighlighter ??= import('./highlight')).then((m) => {
      highlighter = m;
      if (live) setMod(m);
    });
    return () => {
      live = false;
    };
  }, [mod]);
  const key = lines.join('\n');
  return useMemo(
    () => (mod ? mod.highlightLines(key.split('\n'), language ? mod.knownLanguage(language) : mod.languageOf(file)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mod, key, file, language],
  );
}

/** One line of code: highlighted HTML when there is some (the highlighter escapes the text), else the text. */
export function CodeText({ html, text, className }: { html?: string; text: string; className: string }) {
  return html !== undefined && text ? (
    <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className={className}>{text || ' '}</span>
  );
}

/* ---------- Images ---------- */

/**
 * The image a tool call's result carried (a Read of a picture), from the
 * transcript; for a call whose result has none, the file it names, read
 * again from disk (as a thumbnail).
 */
export function ToolImage({ row, taskId, runId, agentId }: { row: MessageRow; taskId: string; runId: string; agentId?: string }) {
  const hasImage = !!row.image;
  const loaded = useThumbnail(async () => {
    const img =
      hasImage && row.toolUseId
        ? await window.looper.runs.messageImage(taskId, runId, toolImageKey(row.toolUseId), agentId).catch(() => null)
        : null;
    if (img) return `data:${img.mediaType};base64,${img.data}`;
    const thumb = row.file ? await window.looper.sessions.fileThumbnail(taskId, row.file).catch(() => null) : null;
    return thumb ?? 'none';
  }, [taskId, runId, agentId, row.toolUseId, row.file, hasImage]);
  const src: string | null | 'none' = loaded ?? null;
  if (src === null) return <div className="muted tc-image-note">Loading the image…</div>;
  if (src === 'none') return <div className="muted tc-image-note">The image can’t be shown.</div>;
  return <img className="tc-image" src={src} alt={row.file ?? ''} />;
}

/* ---------- Diff ---------- */

/**
 * A diff as GitHub draws its unified view: both line numbers, a mark, the
 * line tinted and the changed words darker, in the file's syntax colors. The
 * old and the new file are colored apart, so neither breaks the other's strings.
 */
export function DiffRows({ rows, file }: { rows: DiffRow[]; file?: string }) {
  const side = (keep: 'add' | 'del') => rows.map((r) => (r.kind === 'hunk' || r.kind === keep ? '' : r.text));
  const oldHtml = useHighlight(side('add'), file);
  const newHtml = useHighlight(side('del'), file);
  // Each number column is as wide as its longest number; a new file has no old numbers, so no old column.
  const digits = (key: 'oldN' | 'newN') => rows.reduce((n, r) => (r.kind === 'hunk' ? n : Math.max(n, r[key].length)), 0);
  const oldDigits = digits('oldN');
  const newDigits = digits('newN');
  return (
    <div className="diff" style={{ '--diff-old-digits': oldDigits, '--diff-new-digits': newDigits } as CSSProperties}>
      {rows.map((r, i) => {
        if (r.kind === 'hunk') {
          return (
            <div key={i} className="diff-hunk">
              {r.text}
            </div>
          );
        }
        const html = (r.kind === 'del' ? oldHtml : newHtml)?.[i] ?? escapeHtml(r.text);
        return (
          <div key={i} className={`diff-line diff-${r.kind}`}>
            {oldDigits > 0 && <span className="diff-num old">{r.oldN}</span>}
            {newDigits > 0 && <span className="diff-num new">{r.newN}</span>}
            <span className="diff-mark">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span>
            <span className="diff-code" dangerouslySetInnerHTML={{ __html: (r.words ? markRanges(html, r.words) : html) || ' ' }} />
          </div>
        );
      })}
    </div>
  );
}

/** One line on one side of a side-by-side diff; null: no line there (the other side has one). */
type Side = { n: number; text: string; kind: 'same' | 'del' | 'add' } | null;

/** A line diff as aligned rows: kept lines side by side, a removed block next to the added one. */
function alignedRows(lines: { op: ' ' | '-' | '+'; text: string }[]): [Side, Side][] {
  const rows: [Side, Side][] = [];
  let na = 0;
  let nb = 0;
  let dels: string[] = [];
  let adds: string[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push([i < dels.length ? { n: ++na, text: dels[i], kind: 'del' } : null, i < adds.length ? { n: ++nb, text: adds[i], kind: 'add' } : null]);
    }
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.op === '-') dels.push(l.text);
    else if (l.op === '+') adds.push(l.text);
    else {
      flush();
      rows.push([
        { n: ++na, text: l.text, kind: 'same' },
        { n: ++nb, text: l.text, kind: 'same' },
      ]);
    }
  }
  flush();
  return rows;
}

/**
 * Two texts side by side under their titles, with line numbers and the changed lines marked. `missing`: a side
 * that has no text at all (not set, no file), which shows `placeholder` on its first line.
 */
export function SideBySideDiff({
  lines,
  titles,
  missing,
  placeholder,
}: {
  lines: { op: ' ' | '-' | '+'; text: string }[];
  titles: [string, string];
  missing: [boolean, boolean];
  placeholder: string;
}) {
  const cell = (s: Side, gone: boolean, first: boolean) =>
    s ? (
      <>
        <td className={`sbs-num ${s.kind}`}>{s.n}</td>
        <td className={`sbs-text ${s.kind}`}>{s.text}</td>
      </>
    ) : (
      <>
        <td className="sbs-num sbs-blank" />
        <td className="sbs-text sbs-blank">{first && gone ? <span className="muted">{placeholder}</span> : null}</td>
      </>
    );
  return (
    <table className="sbs">
      <colgroup>
        <col className="sbs-num-col" />
        <col />
        <col className="sbs-num-col" />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th colSpan={2}>{titles[0]}</th>
          <th colSpan={2}>{titles[1]}</th>
        </tr>
      </thead>
      <tbody>
        {alignedRows(lines).map(([a, b], i) => (
          <tr key={i}>
            {cell(a, missing[0], i === 0)}
            {cell(b, missing[1], i === 0)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Two whole texts compared: side by side on the desktop; a phone, too narrow for two columns, shows one, the
 * removed lines over the added ones, in the file's colors.
 */
export function TextDiff(props: Parameters<typeof SideBySideDiff>[0] & { file?: string }) {
  const rows = useMemo(() => (isPhone ? lineDiffRows(props.lines) : null), [props.lines]);
  return rows ? <DiffRows rows={rows} file={props.file} /> : <SideBySideDiff {...props} />;
}

export function DiffView({ hunks, file }: { hunks: PatchHunk[]; file?: string }) {
  const rows = useMemo(() => hunkRows(hunks), [hunks]);
  return <DiffRows rows={rows} file={file} />;
}

/* ---------- Read result: line-number gutter ---------- */

/** Claude Code numbers a Read result's lines as "12→text", or as "12\ttext" in newer versions. */
const GUTTER_RE = /^\s*(\d+)(?:→|\t)(.*)$/;

export function gutterLines(text: string): { n: string; text: string }[] | null {
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

function CodeView({ lines, file, language, numbered = true }: { lines: { n: string; text: string }[]; file?: string; language?: string; numbered?: boolean }) {
  const html = useHighlight(
    lines.map((l) => l.text),
    file,
    language,
  );
  return (
    <div className={`code-view${numbered ? '' : ' plain'}`}>
      {lines.map((l, i) => (
        <div key={i} className="code-line">
          {numbered && <span className="code-gutter">{l.n}</span>}
          <CodeText className="code-text" html={html?.[i]} text={l.text} />
        </div>
      ))}
    </div>
  );
}

/**
 * Code with numbered lines (unless `numbered` is off); a Read result keeps the numbers it came with. `caption`:
 * a line naming it above, which the desktop draws; a phone's bar already names the screen.
 */
export function CodeBlock({ text, file, language, numbered = true, caption }: { text: string; file?: string; language?: string; numbered?: boolean; caption?: { text: string; title?: string } }) {
  const lines = gutterLines(text) ?? text.replace(/\n$/, '').split('\n').map((t, i) => ({ n: String(i + 1), text: t }));
  return (
    <>
      {caption && !isPhone && (
        <div className="code-caption" title={caption.title}>
          {caption.text}
        </div>
      )}
      <CodeView lines={lines} file={file} language={language} numbered={numbered} />
    </>
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
  /** Rows of a subagent's conversation: its id. */
  agentId?: string;
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
            window.looper.showMessageContextMenu({ taskId: ctx.taskId, runId: ctx.runId, file: f });
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

function bashInput(row: MessageRow, input: Rec): ReactNode {
  const description = str(input.description);
  return (
    <>
      {description && <div className="tc-caption muted">{description}</div>}
      <div className="term-block tc-code">
        <CodeBlock text={str(input.command) ?? ''} language={row.tool === 'PowerShell' ? 'powershell' : 'bash'} numbered={false} />
      </div>
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
      {row.patch ? <DiffView hunks={row.patch} file={row.file} /> : <DiffRows rows={replacedRows(oldText, newText)} file={row.file} />}
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
    // Claude Code on Windows runs commands with its PowerShell tool: same input shape as Bash.
    case 'Bash':
    case 'PowerShell':
      return <>{bashInput(row, input)}</>;
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
      return Object.keys(input).length > 0 ? <ParamTable entries={Object.entries(input)} code={row.tool ? CODE_PARAMS[row.tool] : undefined} /> : plain(row.text);
  }
}

/* ---------- Skills ---------- */

const SKILL_DIR = /^Base directory for this skill:[^\n]*\n*/;

/** A skill the agent loaded: where it came from, then its SKILL.md as formatted text. */
export function SkillView({ text }: { text: string }) {
  const dir = SKILL_DIR.exec(text)?.[0].trim();
  return (
    <>
      {dir && <div className="muted tc-caption mono">{dir}</div>}
      <Markdown text={dir ? text.replace(SKILL_DIR, '') : text} breaks={false} />
    </>
  );
}

/* ---------- Result renders ---------- */

export function ToolResultView({ row, ctx }: { row: MessageRow; ctx: FileCtx }) {
  const result = row.result ?? '';
  if (row.image) return <ToolImage row={row} taskId={ctx.taskId} runId={ctx.runId} agentId={ctx.agentId} />;
  switch (row.tool) {
    case 'Skill':
      return row.skill ? <SkillView text={row.skill} /> : plain(result);
    case 'Task':
    case 'Agent':
      return <MessageBody text={result} />;
    case 'Bash':
    case 'PowerShell': {
      const text = stripAnsi(result);
      const parsed = parseJson(text);
      return parsed !== undefined ? jsonTree(parsed) : plain(text);
    }
    case 'Read': {
      const lines = gutterLines(result);
      return lines ? <CodeView lines={lines} file={row.file} /> : plain(result);
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
