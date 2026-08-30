import path from 'node:path';
import { tail, writeJsonAtomic, writeText } from '../store/fsutil';
import { buildPrompt, runCaptured, targetFile, writeLauncher, type RunContext } from './common';

export interface ClassifyResult {
  status: 'act' | 'noop' | 'error';
  reason?: string;
  error?: string;
  costUsd?: number;
  durationMs: number;
  exitCode: number | null;
}

export const CLASSIFIER_SCHEMA = {
  type: 'object',
  properties: {
    act: { type: 'boolean', description: 'true if an agent should be started now' },
    reason: { type: 'string', description: 'one sentence' },
  },
  required: ['act', 'reason'],
  additionalProperties: false,
};

export type ParsedClassifier =
  | { ok: true; act: boolean; reason: string; costUsd?: number }
  | { ok: false; error: string };

/** Parse the `claude -p --output-format json --json-schema` envelope. */
export function parseClassifierOutput(stdout: string): ParsedClassifier {
  const text = stdout.trim();
  if (!text) return { ok: false, error: 'classifier produced no output' };
  let env: Record<string, unknown>;
  try {
    // The envelope is the last JSON object in stdout (claude may print warnings first).
    const start = text.indexOf('{');
    env = JSON.parse(text.slice(start)) as Record<string, unknown>;
  } catch {
    return { ok: false, error: `classifier output is not JSON: ${tail(text, 300)}` };
  }
  if (env.is_error) return { ok: false, error: `classifier error: ${String(env.result ?? '')}` };
  const cost = typeof env.total_cost_usd === 'number' ? env.total_cost_usd : undefined;
  let so = env.structured_output as Record<string, unknown> | undefined;
  if (!so && typeof env.result === 'string') {
    try {
      so = JSON.parse(env.result) as Record<string, unknown>;
    } catch {
      /* fallthrough */
    }
  }
  if (so && typeof so.act === 'boolean') {
    return { ok: true, act: so.act, reason: String(so.reason ?? ''), costUsd: cost };
  }
  return { ok: false, error: `classifier returned no {act} object: ${tail(text, 300)}` };
}

export async function runClassify(ctx: RunContext): Promise<ClassifyResult> {
  const { task, target, settings } = ctx;
  const cls = task.classifier!;
  const promptText = buildPrompt(cls.prompt, ctx.vars);
  writeText(path.join(ctx.runDir, 'classify-prompt.txt'), promptText);
  writeJsonAtomic(path.join(ctx.runDir, 'classify-schema.json'), CLASSIFIER_SCHEMA);

  const q = (s: string) => target.quote(s);
  const parts = [
    settings.claudeCommand,
    '-p',
    '--model',
    q(cls.model),
    '--output-format',
    'json',
    '--json-schema',
    target.catFile(targetFile(ctx, 'classify-schema.json')),
    '--max-budget-usd',
    String(cls.maxBudgetUsd),
    target.catFile(targetFile(ctx, 'classify-prompt.txt')),
  ];
  const launcher = writeLauncher(ctx, 'classify', parts.join(' '));
  const res = await runCaptured(launcher.spec, {
    timeoutMs: cls.timeoutSec * 1000,
    onTimeout: () => target.killLeftovers(ctx.runId),
  });
  writeText(path.join(ctx.runDir, 'classify.out.txt'), res.stdout);
  if (res.stderr) writeText(path.join(ctx.runDir, 'classify.err.txt'), res.stderr);

  const base = { durationMs: res.durationMs, exitCode: res.code };
  if (res.error && res.code === null) return { status: 'error', error: res.error, ...base };
  const parsed = parseClassifierOutput(res.stdout);
  if (!parsed.ok) {
    const err = res.code !== 0 ? `classifier exited ${res.code}: ${parsed.error}` : parsed.error;
    return { status: 'error', error: tail(err + (res.stderr ? ' | ' + res.stderr.trim() : ''), 600), ...base };
  }
  return { status: parsed.act ? 'act' : 'noop', reason: parsed.reason, costUsd: parsed.costUsd, ...base };
}
