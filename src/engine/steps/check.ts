import path from 'node:path';
import type { CheckOutput } from '../../shared/types';
import { tail, writeText } from '../store/fsutil';
import { runCaptured, writeLauncher, type RunContext } from './common';

export interface CheckResult {
  status: 'act' | 'noop' | 'error';
  summary?: string;
  context?: unknown;
  error?: string;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
}

export type ParsedCheck = { ok: true; value: CheckOutput } | { ok: false; error: string };

/** Contract: the last non-empty stdout line is JSON with a boolean `act`. */
export function parseCheckOutput(stdout: string): ParsedCheck {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return { ok: false, error: 'check produced no output' };
  let obj: unknown;
  try {
    obj = JSON.parse(last);
  } catch {
    return { ok: false, error: `last stdout line is not JSON: ${tail(last, 200)}` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'check JSON must be an object' };
  }
  const rec = obj as Record<string, unknown>;
  if (typeof rec.act !== 'boolean') return { ok: false, error: 'check JSON needs boolean "act"' };
  const value: CheckOutput = { act: rec.act };
  if (rec.summary !== undefined) value.summary = String(rec.summary);
  if (rec.context !== undefined) value.context = rec.context;
  return { ok: true, value };
}

export async function runCheck(ctx: RunContext): Promise<CheckResult> {
  const check = ctx.task.check;
  if (!check) throw new Error(`task ${ctx.task.id} has no check step`);
  const launcher = writeLauncher(ctx, 'check', check.command);
  const res = await runCaptured(launcher.spec, {
    timeoutMs: check.timeoutSec * 1000,
    signal: ctx.signal,
    onKill: () => ctx.target.killLeftovers(ctx.runId),
  });
  writeText(path.join(ctx.runDir, 'check.out.txt'), res.stdout);
  if (res.stderr) writeText(path.join(ctx.runDir, 'check.err.txt'), res.stderr);

  const base = { exitCode: res.code, durationMs: res.durationMs, stdoutTail: tail(res.stdout, 1500) };
  if (res.error && res.code === null) {
    return { status: 'error', error: res.error, ...base };
  }
  if (res.code !== 0) {
    const err = tail(res.stderr.trim() || res.stdout.trim(), 500);
    return { status: 'error', error: `check exited ${res.code}${err ? ': ' + err : ''}`, ...base };
  }
  const parsed = parseCheckOutput(res.stdout);
  if (!parsed.ok) return { status: 'error', error: parsed.error, ...base };
  return {
    status: parsed.value.act ? 'act' : 'noop',
    summary: parsed.value.summary,
    context: parsed.value.context,
    ...base,
  };
}
