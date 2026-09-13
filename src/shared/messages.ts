/** One row of the Messages view: a prompt, an agent reply, a thought, a tool call, or (raw mode) a record. */
export interface MessageRow {
  /** Stable per-transcript id (monotonic; survives head truncation). */
  id: string;
  /** ISO timestamp of the transcript record, when it carries one. */
  ts?: string;
  kind: 'prompt' | 'agent' | 'thinking' | 'tool' | 'raw';
  /** Set on rows from the classifier's conversation; assistant rows then show "Classifier". */
  source?: 'classifier';
  /** Tool rows: the tool name (Bash, Read, Task…). Raw rows: the record's type. */
  tool?: string;
  /** One line for the table. */
  preview: string;
  /** Full content: markdown for prompt/agent, plain text for thinking, the rendered input for tools. */
  text: string;
  /** Tool rows: the result text, once the tool has finished. */
  result?: string;
  resultError?: boolean;
  /** Task tool rows: the subagent id, once known — its conversation can be opened. */
  agentId?: string;
  /** The row carries an image (kept engine-side; fetch it via runs.messageImage). */
  image?: { mediaType: string };
  /** The file the tool operated on (file_path/notebook_path input), in the run target's path form. */
  file?: string;
  /** Tool rows: the structured input, for custom renders (omitted when oversized). */
  input?: unknown;
  /** Edit/Write rows: the diff hunks the harness recorded for the change. */
  patch?: PatchHunk[];
}

/** One hunk of a recorded file change; lines are prefixed ' ', '-' or '+'. */
export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface MessageImage {
  mediaType: string;
  /** Base64 payload, as recorded in the transcript. */
  data: string;
}

export type MessagesStatus =
  /** Rows are valid (possibly empty: the session just started). */
  | 'ok'
  /** The run has no recorded session (custom harness, or the session has not started yet). */
  | 'no-session'
  /** The session is known but its transcript cannot be read (cleaned up, or not written yet). */
  | 'no-transcript';

export interface MessagesResult {
  status: MessagesStatus;
  rows: MessageRow[];
  /** Rows dropped from the start of an oversized transcript. */
  dropped: number;
}
