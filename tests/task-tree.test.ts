import { describe, expect, it } from 'vitest';
import type { Task, TaskFolder } from '../src/shared/types';
import { siblingOrder, taskEntries, type TaskTree } from '../src/renderer/src/task-tree';

const task = (id: string, folderId?: string): Task => ({ id, name: id, folderId }) as unknown as Task;
const folder = (id: string, parentId?: string): TaskFolder => ({ id, name: id, parentId }) as unknown as TaskFolder;

/**
 * The audit's MN-01 case: Development > Nightly > Flaky, and "docs" a direct
 * child of Development listed after the Nightly subtree.
 */
const tree = (over: Partial<TaskTree> = {}): TaskTree => ({
  tasks: [task('triage'), task('docs', 'dev'), task('nightly-a', 'nightly'), task('flaky-a', 'flaky'), task('flaky-b', 'flaky')],
  folders: [folder('dev'), folder('nightly', 'dev'), folder('flaky', 'nightly')],
  layout: { '': ['folder:dev', 'triage'], dev: ['folder:nightly', 'docs'], nightly: ['folder:flaky', 'nightly-a'], flaky: ['flaky-a', 'flaky-b'] },
  passes: () => true,
  showFolders: true,
  hideEmptyFolders: false,
  ...over,
});

const names = (entries: ReturnType<typeof taskEntries>) => entries.map((e) => (e.kind === 'folder' ? `folder:${e.folder.id}(${e.count})` : e.task.id));

describe('the Tasks tab drills down one level at a time', () => {
  it('lists the top level: folders as rows with their subtree count, then the tasks, in the layout order', () => {
    expect(names(taskEntries('', tree()))).toEqual(['folder:dev(4)', 'triage']);
  });

  it('a folder lists its subfolders and tasks; a task after a subfolder is not inside it', () => {
    expect(names(taskEntries('dev', tree()))).toEqual(['folder:nightly(3)', 'docs']);
    expect(names(taskEntries('nightly', tree()))).toEqual(['folder:flaky(2)', 'nightly-a']);
    expect(names(taskEntries('flaky', tree()))).toEqual(['flaky-a', 'flaky-b']);
  });

  it('follows the layout, and appends what the layout does not know yet', () => {
    const t = tree({ layout: { '': ['triage', 'folder:dev'], dev: ['docs'] } });
    expect(names(taskEntries('', t))).toEqual(['triage', 'folder:dev(4)']);
    // The subfolder the layout hasn't heard of comes after the listed task.
    expect(names(taskEntries('dev', t))).toEqual(['docs', 'folder:nightly(3)']);
  });

  it('puts a task of an unknown folder at the top level and drops layout entries that no longer exist', () => {
    const t = tree({ tasks: [task('lost', 'gone'), task('docs', 'dev')], layout: { '': ['ghost', 'folder:nope'] } });
    expect(names(taskEntries('', t))).toEqual(['folder:dev(1)', 'lost']);
  });

  it('counts only the tasks the filters show, and can hide the folders that end up empty', () => {
    const passes = (t: Task) => t.id !== 'flaky-a' && t.id !== 'flaky-b';
    expect(names(taskEntries('nightly', tree({ passes })))).toEqual(['folder:flaky(0)', 'nightly-a']);
    expect(names(taskEntries('nightly', tree({ passes, hideEmptyFolders: true })))).toEqual(['nightly-a']);
  });

  it('with folders off lists every shown task in tree order at the top level, and nothing inside a folder', () => {
    const t = tree({ showFolders: false });
    // Development's Nightly subtree (its Flaky folder first), then docs, then triage.
    expect(names(taskEntries('', t))).toEqual(['flaky-a', 'flaky-b', 'nightly-a', 'docs', 'triage']);
    expect(taskEntries('dev', t)).toEqual([]);
  });

  it('siblingOrder is what the desktop list orders by', () => {
    const t = tree();
    const order = siblingOrder(t.tasks, t.folders, t.layout);
    expect(order.get('dev')).toEqual(['folder:nightly', 'docs']);
    expect(order.get('')).toEqual(['folder:dev', 'triage']);
  });
});
