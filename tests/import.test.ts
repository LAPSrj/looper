import { describe, expect, it } from 'vitest';
import { importTaskDraft } from '../src/shared/validate';
import { defaultEnvironments } from '../src/shared/types';

const opts = { environments: defaultEnvironments('windows'), host: 'windows', defaultEnvironmentId: 'local' };

const good = {
  id: 'nightly',
  name: 'Nightly',
  enabled: false,
  schedule: { cron: '0 3 * * *' },
  environmentId: 'wsl',
  cwd: '/home/me/repo',
  check: { command: 'git status', timeoutSec: 30 },
  agent: { harnessId: 'claude', model: 'opus', prompt: 'do it', maxRuntimeMin: 45, mode: 'headless' },
  backoff: { maxConsecutiveErrors: 2 },
};

describe('importTaskDraft', () => {
  it('keeps every valid field', () => {
    const d = importTaskDraft({ ...good, createdAt: 'x', updatedAt: 'y' }, opts);
    expect(d).toMatchObject(good);
    expect(d.createdAt).toBeUndefined();
    expect(d.updatedAt).toBeUndefined();
  });

  it('turns garbage into an empty draft with defaults', () => {
    const d = importTaskDraft({ id: 42, name: null, schedule: 'daily', agent: [] }, opts);
    expect(d.id).toBe('');
    expect(d.name).toBe('');
    expect(d.enabled).toBe(true);
    expect(d.schedule).toEqual({ enabled: true, cron: '' });
    expect(d.environmentId).toBe('local');
    expect(d.cwd).toBe('');
    expect(d.check).toBeUndefined();
    expect(d.classifier).toBeUndefined();
    expect(d.agent).toMatchObject({ prompt: '', extraArgs: [], mode: 'interactive', permissionMode: 'auto', maxRuntimeMin: 120 });
    expect(d.backoff).toEqual({ maxConsecutiveErrors: 5 });
  });

  it('resets only the invalid leaves of a nested object', () => {
    const d = importTaskDraft({ ...good, agent: { ...good.agent, maxRuntimeMin: -1, mode: 'weird' } }, opts);
    expect(d.agent.prompt).toBe('do it');
    expect(d.agent.model).toBe('opus');
    expect(d.agent.maxRuntimeMin).toBe(120);
    expect(d.agent.mode).toBe('interactive');
  });

  it('fills a partial classifier with defaults but drops a non-object one', () => {
    expect(importTaskDraft({ ...good, classifier: { prompt: 7 } }, opts).classifier).toEqual({
      enabled: true,
      model: 'haiku',
      prompt: '',
      mode: 'headless',
      timeoutSec: 180,
    });
    expect(importTaskDraft({ ...good, classifier: 'yes' }, opts).classifier).toBeUndefined();
  });

  it('blanks a cron expression that does not parse', () => {
    expect(importTaskDraft({ ...good, schedule: { cron: 'every day' } }, opts).schedule.cron).toBe('');
  });

  it('keeps a known schedule timezone and drops an unknown one', () => {
    expect(importTaskDraft({ ...good, schedule: { cron: '0 3 * * *', timezone: 'Asia/Tokyo' } }, opts).schedule.timezone).toBe('Asia/Tokyo');
    expect(importTaskDraft({ ...good, schedule: { cron: '0 3 * * *', timezone: 'Not/AZone' } }, opts).schedule.timezone).toBeUndefined();
  });

  it('falls back to the default environment and drops unknown harnesses', () => {
    const d = importTaskDraft({ ...good, environmentId: 'mars', agent: { ...good.agent, harnessId: 'nope' } }, opts);
    expect(d.environmentId).toBe('local');
    expect(d.agent.harnessId).toBeUndefined();
  });

  it('blanks a cwd in the wrong path style for the environment', () => {
    expect(importTaskDraft({ ...good, environmentId: 'local', cwd: '/home/me' }, opts).cwd).toBe('');
    expect(importTaskDraft({ ...good, cwd: 'C:\\repo' }, opts).cwd).toBe('');
  });

  it('blanks an id that is already taken', () => {
    expect(importTaskDraft(good, { ...opts, existingIds: ['nightly'] }).id).toBe('');
    expect(importTaskDraft(good, { ...opts, existingIds: ['other'] }).id).toBe('nightly');
  });
});
