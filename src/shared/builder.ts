import type { MessageRow } from './messages';
import type { Task } from './types';

/** What the task builder runs with: chosen in its setup window, or taken from the task for Edit with Agent. */
export interface BuilderSetup {
  environmentId: string;
  harnessId: string;
  model?: string;
  effort?: string;
  /** The task's working directory, in the environment's native form. */
  cwd: string;
  /** Edit with Agent: the task being changed. */
  taskId?: string;
}

/** One operation of an access test, as the probe session reported it. */
export interface ProbeOperation {
  operation: string;
  allowed: boolean;
  detail?: string;
}

/** One `looper-test` run the builder asked for. */
export interface BuilderTest {
  id: number;
  kind: 'check' | 'agent';
  status: 'running' | 'passed' | 'failed';
  startedAt: number;
  endedAt?: number;
  /** One line: the check's verdict and summary, or how many operations were allowed. */
  summary: string;
  /** agent: what each operation of the probe found. */
  operations?: ProbeOperation[];
}

/** The task definition the builder keeps in its draft file, as Looper last read it. */
export interface BuilderDraft {
  /** The draft passed validation. */
  task?: Task;
  /** Why it doesn't (unreadable JSON included). Empty when valid. */
  errors: string[];
  /** Edit with Agent: dotted paths of the fields that differ from the stored task. */
  changed?: string[];
  /** The raw JSON as last read, so the panel can still show a draft that doesn't validate. */
  raw?: Record<string, unknown>;
}

/** The task builder's chat as its window shows it. */
export interface BuilderState {
  id: string;
  /** new = File → New Task with Agent; edit = Edit with Agent, or a new task once it was created. */
  mode: 'new' | 'edit';
  /** The stored task the draft saves over: Edit with Agent's, or the one Create stored. */
  taskId?: string;
  setup: BuilderSetup;
  harnessName: string;
  harnessKind: 'claude-code' | 'codex';
  /** chat = the message view; terminal = the harness's own interactive session. */
  view: 'chat' | 'terminal';
  /** working = the agent is on a turn; ended = the session is gone (see error). */
  status: 'starting' | 'ready' | 'working' | 'ended';
  error?: string;
  /** chat view only. */
  rows: MessageRow[];
  draft: BuilderDraft;
  tests: BuilderTest[];
  /** Files the builder created or changed with its file tools, target-native. */
  files: string[];
  /** Those of `files` whose content differs from the last save (or from before the builder, until then). */
  changedFiles: string[];
  /** The draft or the task's files differ from what was last saved (or, for a new task, from the start). */
  unsaved: boolean;
  /** Undo/Redo through the changes to the work in progress: agent turns and loaded versions. */
  history: {
    canUndo: boolean;
    canRedo: boolean;
  };
}
