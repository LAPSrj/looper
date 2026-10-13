import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitForInbox } from '../src/cli/inbox-wait';
import { Inbox } from '../src/engine/inbox';
import type { Logger } from '../src/engine/log';
import type { Task } from '../src/shared/types';

const log = { info() {}, warn() {}, error() {} } as unknown as Logger;

function setup(onTask: (input: unknown) => Task) {
  const dir = join(mkdtempSync(join(tmpdir(), 'looper-inbox-')), 'inbox');
  const inbox = new Inbox(dir, 20, { onTask, onCommand: () => {} }, log);
  inbox.start();
  const drop = (name: string) => {
    const file = join(dir, name);
    writeFileSync(file, JSON.stringify({ id: 'a', name: 'a' }), 'utf8');
    return file;
  };
  return { inbox, drop };
}

describe('waitForInbox', () => {
  it('reports a file the app stored as processed', async () => {
    const { inbox, drop } = setup((input) => input as Task);
    const outcome = await waitForInbox(drop('task-a-1.json'), 2000, 10);
    inbox.stop();
    expect(outcome).toEqual({ status: 'processed' });
  });

  it("reports a rejection with the app's reason", async () => {
    const { inbox, drop } = setup(() => {
      throw new Error('Environment: unknown environment "nope"');
    });
    const outcome = await waitForInbox(drop('task-a-2.json'), 2000, 10);
    inbox.stop();
    expect(outcome).toEqual({ status: 'rejected', reason: 'Environment: unknown environment "nope"' });
  });

  it('reports a file nothing picked up as pending, and leaves it queued', async () => {
    const { inbox, drop } = setup((input) => input as Task);
    inbox.stop();
    const file = drop('task-a-3.json');
    expect(await waitForInbox(file, 100, 10)).toEqual({ status: 'pending' });
    expect(existsSync(file)).toBe(true);
  });

  it('reports a file that left the inbox without being filed as vanished', async () => {
    const { inbox, drop } = setup((input) => input as Task);
    inbox.stop();
    const file = drop('task-a-4.json');
    rmSync(file);
    expect(await waitForInbox(file, 100, 10)).toEqual({ status: 'vanished' });
  });
});
