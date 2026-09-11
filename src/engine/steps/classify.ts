import type { Harness } from '../../shared/types';
import { resolveClassifierHarness, resolveEnvironment } from '../../shared/environments';
import { tail } from '../store/fsutil';
import { buildPrompt, noteSection, type RunContext } from './common';
import { headlineOf, startSession, type SessionCallbacks, type SessionEnd, type SessionHandle } from './session';

export interface ClassifyResult {
  status: 'act' | 'noop' | 'error' | 'stopped';
  /** The classifier's one-line justification. */
  reason?: string;
  /** The classifier's final message (its full report), Markdown. */
  body?: string;
  error?: string;
  /** The error was a network failure: the API was never reached. */
  network?: boolean;
  costUsd?: number;
  /** Set when a usage limit ended the session: epoch ms of when to try again. */
  retryAtMs?: number;
  durationMs: number;
  exitCode: number | null;
}

export const CLASSIFIER_SCHEMA = {
  type: 'object',
  properties: {
    act: { type: 'boolean', description: 'true if an agent should be started now' },
    reason: { type: 'string', description: 'one sentence explaining why action is or isn\'t needed' },
  },
  required: ['act', 'reason'],
  additionalProperties: false,
};

const CLASSIFY_DONE = { command: 'looper-classify', statuses: ['act', 'noop'] as const };

/** How long an interactive classifier may sit after its turn ended without looper-classify. */
const CLASSIFY_IDLE_GRACE_MS = 2 * 60_000;

/**
 * The classifier's system footer. Headless sessions answer through the
 * --json-schema structured output, so only the interactive session needs the
 * looper-classify contract spelled out.
 */
export function classifierFooter(taskName: string, runId: string): string {
  return [
    `You were started by Looper as the classifier for the task "${taskName}" (run ${runId}). This is a one-shot, unattended session: nobody is typing at the other end.`,
    'Your only job is to decide whether the task\'s agent should be started now. Do not do the agent\'s work yourself.',
    'When you have decided, run the shell command:',
    '    looper-classify act "<reason>"     — the agent should be started',
    '    looper-classify noop "<reason>"    — no action is needed',
    'The reason is one sentence explaining the decision.',
    'Then write a short closing message explaining your decision. Looper closes this session when that message ends.',
  ].join('\n');
}

/** The rendered classifier prompt (also recorded on the classify `started` record).
 * The run's one-off note is appended too: it may bear on the decision to act. */
export function classifyPrompt(ctx: RunContext): string {
  return buildPrompt(ctx.task.classifier!.prompt, ctx.vars) + noteSection(ctx.task.note);
}

export interface ClassifyCallbacks extends SessionCallbacks {
  /** Reports the live session so the scheduler can route stop/input/resize to it. */
  onHandle?: (handle: SessionHandle) => void;
}

/** Maps how the session ended to the classifier verdict. */
export function toClassifyResult(end: SessionEnd, headless: boolean, timeoutSec: number): ClassifyResult {
  const base = { durationMs: end.durationMs, exitCode: end.exitCode, costUsd: end.costUsd, body: end.body };
  switch (end.reason) {
    case 'stopped':
      return { status: 'stopped', reason: end.headline, ...base };
    case 'done': {
      const s = end.structured as Record<string, unknown> | undefined;
      if (s && typeof s.act === 'boolean') {
        return { status: s.act ? 'act' : 'noop', reason: String(s.reason ?? ''), ...base };
      }
      if (end.doneStatus === 'act' || end.doneStatus === 'noop') {
        return { status: end.doneStatus, reason: end.headline !== 'done' ? end.headline : headlineOf(end.body), ...base };
      }
      const where = headless ? 'no {act} structured output' : 'looper-classify was run without act/noop';
      return { status: 'error', error: `classifier gave no verdict: ${where}`, ...base };
    }
    case 'max-runtime':
      return { status: 'error', error: `classifier timed out after ${timeoutSec} s`, network: end.network, ...base };
    case 'idle-timeout':
      return { status: 'error', error: 'classifier session went idle without looper-classify', network: end.network, ...base };
    case 'exited':
      return {
        status: 'error',
        error: tail(`${end.headline ?? 'classifier exited'}${end.body ? ': ' + end.body.trim() : ''}`, 600),
        network: end.network,
        ...base,
      };
    case 'error':
      return { status: 'error', error: end.headline ?? 'classifier failed', network: end.network, retryAtMs: end.retryAtMs, ...base };
  }
}

export async function runClassify(ctx: RunContext, cb: ClassifyCallbacks = { onData: () => {} }): Promise<ClassifyResult> {
  const { task, settings } = ctx;
  const cls = task.classifier!;
  let harness: Harness;
  try {
    harness = resolveClassifierHarness(task, resolveEnvironment(task, settings));
  } catch (e) {
    return { status: 'error', error: (e as Error).message, durationMs: 0, exitCode: null };
  }
  const headless = cls.mode === 'headless';
  const handle = await startSession(
    ctx,
    {
      step: 'classify',
      prefix: 'classify-',
      launcherName: 'classify',
      harness,
      headless,
      model: cls.model,
      extraArgs: [],
      // Headless answers via structured output; a footer would only add a turn.
      footer: headless ? '' : classifierFooter(task.name, ctx.runId),
      prompt: classifyPrompt(ctx),
      jsonSchema: headless ? CLASSIFIER_SCHEMA : undefined,
      doneCommand: CLASSIFY_DONE.command,
      doneStatuses: CLASSIFY_DONE.statuses,
      // Headless without the gate: the structured output already carries the
      // verdict, and a stop-hook reminder would force an extra turn per run.
      stopGate: !headless,
      maxRuntimeMs: cls.timeoutSec * 1000,
      maxRuntimeText: `exceeded the ${cls.timeoutSec} s timeout`,
      idleGraceMs: CLASSIFY_IDLE_GRACE_MS,
      idleText: 'turn ended without looper-classify',
      onIdleTimeout: 'finish',
    },
    cb,
  );
  cb.onHandle?.(handle);
  const stopReason = () => void handle.stop('stopped');
  if (ctx.signal?.aborted) stopReason();
  else ctx.signal?.addEventListener('abort', stopReason, { once: true });
  try {
    const end = await handle.finished;
    return toClassifyResult(end, headless, cls.timeoutSec);
  } finally {
    ctx.signal?.removeEventListener('abort', stopReason);
  }
}
