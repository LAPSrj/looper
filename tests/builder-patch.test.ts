import { describe, expect, it } from 'vitest';
import { codexFileChanges, contentBeforeCodexEdits, unapplyUnifiedDiff } from '../src/engine/builder/patch';

// The two FileChange events codex-cli wrote for two apply_patch calls (captured live).
const ROLLOUT = [
  '{"type":"session_meta","payload":{"id":"x"}}',
  '{"timestamp":"t","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","id":"a","changes":{"/w/existing.txt":{"type":"update","unified_diff":"@@ -1,3 +1,3 @@\\n line one\\n-line two\\n+line 2\\n line three\\n","move_path":null}},"status":"completed"}}}',
  '{"timestamp":"t","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","id":"b","changes":{"/w/existing.txt":{"type":"update","unified_diff":"@@ -2,2 +2,3 @@\\n line 2\\n+line four\\n line three\\n","move_path":null}},"status":"completed"}}}',
  '{"timestamp":"t","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","id":"c","changes":{"/w/new.sh":{"type":"add","content":"echo\\n"}},"status":"completed"}}}',
].join('\n');

describe('codex edits undone', () => {
  it('gets a file back to before all its edits', () => {
    const changes = codexFileChanges(ROLLOUT);
    const now = 'line one\nline 2\nline four\nline three\n';
    expect(contentBeforeCodexEdits(now, changes.get('/w/existing.txt')!)).toBe('line one\nline two\nline three\n');
    expect(contentBeforeCodexEdits('echo\n', changes.get('/w/new.sh')!)).toBeNull();
  });

  it("can't say when something else changed the file", () => {
    const changes = codexFileChanges(ROLLOUT);
    expect(contentBeforeCodexEdits('line one\nchanged by hand\n', changes.get('/w/existing.txt')!)).toBeUndefined();
  });

  it('undoes a multi-hunk diff', () => {
    const diff = '@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -5,2 +5,3 @@\n e\n+E2\n f\n';
    expect(unapplyUnifiedDiff('A\nb\nc\nd\ne\nE2\nf\n', diff)).toBe('a\nb\nc\nd\ne\nf\n');
  });
});
