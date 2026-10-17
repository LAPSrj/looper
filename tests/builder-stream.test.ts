import { describe, expect, it } from 'vitest';
import { ClaudeStreamAccumulator, CodexExecAccumulator, unwrapShell } from '../src/engine/builder/stream';

// Lines captured live from claude 2.1.302 (`-p --output-format stream-json`) and
// codex-cli (`exec --json`), trimmed to the fields that matter.
const CLAUDE = [
  '{"type":"system","subtype":"init","session_id":"s"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/w/a.txt","old_string":"one","new_string":"two"}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"The file /w/a.txt has been updated successfully."}]},"tool_use_result":{"filePath":"/w/a.txt","oldString":"one","newString":"two","originalFile":"one\\n","structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-one","+two"]}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}',
  '{"type":"result","subtype":"success","result":"Done."}',
];

const CODEX = [
  '{"type":"thread.started","thread_id":"01a1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Running it."}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \'echo hello\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/bash -lc \'echo hello\'","aggregated_output":"hello\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.started","item":{"id":"item_2","type":"file_change","changes":[{"path":"/w/patched.txt","kind":"add"}],"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/w/patched.txt","kind":"add"}],"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"DONE"}}',
  '{"type":"turn.completed","usage":{}}',
];

describe('ClaudeStreamAccumulator', () => {
  it('folds stream-json into rows, with the edit diff and the user prompt', () => {
    const acc = new ClaudeStreamAccumulator();
    acc.addPrompt('change a.txt');
    for (const line of CLAUDE) acc.addLine(line);
    expect(acc.rows.map((r) => [r.kind, r.tool ?? '', r.kind === 'tool' ? r.file : r.text])).toEqual([
      ['prompt', '', 'change a.txt'],
      ['tool', 'Edit', '/w/a.txt'],
      ['agent', '', 'Done.'],
    ]);
    expect(acc.rows[1].patch?.[0].lines).toEqual(['-one', '+two']);
    expect(acc.rows[1].result).toContain('updated successfully');
  });
});

describe('CodexExecAccumulator', () => {
  it('shows a command while it runs and fills in its output in place', () => {
    const acc = new CodexExecAccumulator();
    acc.addLine(CODEX[3]);
    expect(acc.rows).toHaveLength(1);
    expect(acc.rows[0]).toMatchObject({ kind: 'tool', tool: 'Bash', text: 'echo hello' });
    acc.addLine(CODEX[4]);
    expect(acc.rows).toHaveLength(1);
    expect(acc.rows[0].result).toBe('hello\n');
  });

  it('folds a whole turn into messages, a command and a file change', () => {
    const acc = new CodexExecAccumulator();
    for (const line of CODEX) acc.addLine(line);
    expect(acc.rows.map((r) => [r.kind, r.tool ?? '', r.file ?? r.text])).toEqual([
      ['agent', '', 'Running it.'],
      ['tool', 'Bash', 'echo hello'],
      ['tool', 'Write', '/w/patched.txt'],
      ['agent', '', 'DONE'],
    ]);
  });

  it('reports a failed turn as an error message', () => {
    const acc = new CodexExecAccumulator();
    acc.addLine('{"type":"turn.failed","error":{"message":"usage limit reached"}}');
    expect(acc.rows[0]).toMatchObject({ kind: 'agent', text: 'Error: usage limit reached' });
  });
});

describe('unwrapShell', () => {
  it('strips the shell wrapper codex reports', () => {
    expect(unwrapShell("/bin/bash -lc 'echo hello'")).toBe('echo hello');
    expect(unwrapShell(`/bin/bash -lc "printf 'first\\\\n' > note.txt"`)).toBe("printf 'first\\n' > note.txt");
    expect(unwrapShell("bash -lc 'it'\\''s'")).toBe("it's");
    expect(unwrapShell('ls -la')).toBe('ls -la');
  });
});
