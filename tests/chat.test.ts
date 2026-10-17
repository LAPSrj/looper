import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_INLINE_IMAGE, claudeUserMessage, imageMediaType, permissionAnswer, withFileList } from '../src/engine/chat';
import { RunStore } from '../src/engine/store/runs';
import { BashTarget } from '../src/engine/target';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'looper-chat-'));

describe('chat messages', () => {
  it('lists the files the agent reads by path after the text', () => {
    expect(withFileList('Look at these', [])).toBe('Look at these');
    expect(withFileList('Look at these', ['/a/spec.pdf', '/a/notes.txt'])).toBe(
      'Look at these\n\nAttached files (read them from these paths):\n- /a/spec.pdf\n- /a/notes.txt',
    );
    expect(withFileList('', ['/a/spec.pdf'])).toBe('Attached files (read them from these paths):\n- /a/spec.pdf');
  });

  it('sends images inside the message and other files, or oversized images, by path', () => {
    const files: Record<string, Buffer> = {
      '/h/small.png': Buffer.from('png-bytes'),
      '/h/huge.jpg': Buffer.alloc(MAX_INLINE_IMAGE + 1),
    };
    const msg = claudeUserMessage(
      'What is this?',
      [
        { name: 'small.png', path: '/h/small.png', image: true },
        { name: 'huge.jpg', path: '/h/huge.jpg', image: true },
        { name: 'spec.pdf', path: '/h/spec.pdf', image: false },
      ],
      (p) => `/target${p}`,
      (p) => files[p],
    ) as { message: { content: Record<string, unknown>[] } };
    expect(msg.message.content).toEqual([
      {
        type: 'text',
        text: 'What is this?\n\nAttached files (read them from these paths):\n- /target/h/huge.jpg\n- /target/h/spec.pdf',
      },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png-bytes').toString('base64') } },
    ]);
  });

  it('sends an image alone without an empty text block', () => {
    const msg = claudeUserMessage('', [{ name: 'a.webp', path: '/h/a.webp', image: true }], (p) => p, () => Buffer.from('x')) as {
      message: { content: { type: string }[] };
    };
    expect(msg.message.content.map((b) => b.type)).toEqual(['image']);
  });

  it('knows the image types the agents can see', () => {
    expect(imageMediaType('/x/Shot.PNG')).toBe('image/png');
    expect(imageMediaType('/x/photo.jpeg')).toBe('image/jpeg');
    expect(imageMediaType('/x/doc.pdf')).toBeUndefined();
  });

  it("answers claude's permission hook in its decision format", () => {
    expect(JSON.parse(permissionAnswer(true, { command: 'ls' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { command: 'ls' } } },
    });
    expect(JSON.parse(permissionAnswer(false, {})).hookSpecificOutput.decision).toEqual({
      behavior: 'deny',
      message: 'The user denied this in Looper.',
    });
  });
});

describe('attachments', () => {
  it('copies files under the task with a stamp, and prunes them with the run logs', () => {
    const store = new RunStore(tmp());
    const src = path.join(tmp(), 'notes.txt');
    fs.writeFileSync(src, 'hello');
    const a = store.saveAttachment('t1', 'notes.txt', { file: src });
    const b = store.saveAttachment('t1', 'bad:name?.png', { data: Buffer.from('img') });
    expect(fs.readFileSync(a, 'utf8')).toBe('hello');
    expect(RunStore.attachmentName(a)).toBe('notes.txt');
    expect(RunStore.attachmentName(b)).toBe('bad_name_.png');
    expect(path.dirname(a)).toBe(store.attachmentsDir('t1'));
    // An hour from now: both are older than that.
    expect(store.pruneAttachments('t1', Date.now() + 3_600_000)).toBe(2);
    expect(fs.readdirSync(store.attachmentsDir('t1'))).toEqual([]);
  });

  it('keeps attachments newer than the cutoff', () => {
    const store = new RunStore(tmp());
    store.saveAttachment('t1', 'a.png', { data: Buffer.from('x') });
    expect(store.pruneAttachments('t1', Date.now() - 3_600_000)).toBe(0);
  });
});

describe('permission hook (bash)', () => {
  it('hands the request over as a file and prints the answer Looper writes', async () => {
    const dir = tmp();
    const queue = path.join(dir, 'permissions');
    const script = path.join(dir, 'hook');
    fs.writeFileSync(script, new BashTarget({ host: 'linux' }, undefined).renderPermissionHook(queue));
    const child = spawn('bash', [script], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.end('{"tool_name":"Bash","tool_input":{"command":"ls"}}');
    // Looper's side: wait for the request, then answer it.
    let req: string | undefined;
    for (let i = 0; i < 50 && !req; i++) {
      await new Promise((r) => setTimeout(r, 100));
      req = fs.existsSync(queue) ? fs.readdirSync(queue).find((f) => f.endsWith('.req')) : undefined;
    }
    expect(req).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(queue, req!), 'utf8')).tool_name).toBe('Bash');
    fs.writeFileSync(path.join(queue, req!.replace(/\.req$/, '.ans')), permissionAnswer(true, { command: 'ls' }));
    const code = await new Promise((r) => child.on('close', r));
    expect(code).toBe(0);
    expect(JSON.parse(out).hookSpecificOutput.decision.behavior).toBe('allow');
    expect(fs.readdirSync(queue)).toEqual([]);
  });
});
