import { describe, expect, it } from 'vitest';
import { parseWatchArgs, watchedLines, withWatch } from '../src/engine/task-watch';
import type { TaskWatch } from '../src/shared/chat';

describe('looper-watch', () => {
  it('reads what a call asks for, and says why one is wrong', () => {
    expect(parseWatchArgs(['tasks'])).toEqual({ op: 'tasks' });
    expect(parseWatchArgs(['task', 'deploy'])).toEqual({ op: 'watch', watch: { taskId: 'deploy', what: 'runs' } });
    expect(parseWatchArgs(['events', 'slack', '1794.5'])).toEqual({ op: 'watch', watch: { taskId: 'slack', what: 'events', eventId: '1794.5' } });
    expect(parseWatchArgs(['events', 'slack'])).toEqual({ op: 'watch', watch: { taskId: 'slack', what: 'events' } });
    expect(parseWatchArgs(['stop', 'slack'])).toEqual({ op: 'stop', taskId: 'slack' });
    expect(parseWatchArgs(['task'])).toEqual({ error: 'task needs one task id' });
    expect(parseWatchArgs(['events', 'slack', '1', '2'])).toHaveProperty('error');
    expect(parseWatchArgs([])).toEqual({ error: 'no command given' });
  });

  it('keeps one watch for each thing, all of a task’s events covering each event id', () => {
    const one: TaskWatch = { taskId: 's', what: 'events', eventId: '1' };
    const all: TaskWatch = { taskId: 's', what: 'events' };
    expect(withWatch([one], one)).toEqual([one]);
    expect(withWatch([one], { ...one, eventId: '2' })).toEqual([one, { ...one, eventId: '2' }]);
    expect(withWatch([one, { taskId: 'r', what: 'runs' }], all)).toEqual([{ taskId: 'r', what: 'runs' }, all]);
    expect(withWatch([all], one)).toEqual([all]);
  });

  it('takes the event lines whose related id it watches, or all of them', () => {
    const lines = ['{"looper_related_id":1}', '{"looper_related_id":"2"}', 'plain text'];
    expect(watchedLines([{ taskId: 's', what: 'events', eventId: '1' }], 's', lines)).toEqual([lines[0]]);
    expect(watchedLines([{ taskId: 's', what: 'events' }], 's', lines)).toEqual(lines);
    expect(watchedLines([{ taskId: 's', what: 'runs' }], 's', lines)).toEqual([]);
    expect(watchedLines([{ taskId: 'o', what: 'events' }], 's', lines)).toEqual([]);
  });
});
