import type { z } from 'zod';

/** Parse with this so issues carry `input`, which issueMessage needs to tell a missing field from a wrong one. */
export const REPORT_INPUT = { reportInput: true };

/** Zod's wording for the common cases, translated for Looper's error dialogs. */
export function issueMessage(issue: z.core.$ZodIssue): string {
  const missing = 'input' in issue && issue.input === undefined;
  if (issue.code === 'too_small' && issue.origin === 'string') return 'must not be empty';
  if ((issue.code === 'invalid_type' || issue.code === 'invalid_value') && missing) return 'is required';
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((k) => `unknown field "${k}"`).join(', ');
  }
  return issue.message;
}

/** One `path: message` line per issue, the first `max` of them. */
export function issueLines(err: z.ZodError, max = Infinity): string {
  return err.issues
    .slice(0, max)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${issueMessage(i)}`)
    .join('\n');
}
