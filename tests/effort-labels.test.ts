import { describe, expect, it } from 'vitest';
import { effortLabel, permissionLabel } from '../src/shared/environments';

describe('effortLabel and permissionLabel', () => {
  it('give the label the kind lists', () => {
    expect(effortLabel('claude-code', 'xhigh')).toBe('Extra high');
    expect(effortLabel('codex', 'minimal')).toBe('Minimal');
    expect(permissionLabel('claude-code', 'bypassPermissions')).not.toBe('bypassPermissions');
  });

  it('give the value itself for a custom harness, no kind or an unknown value', () => {
    expect(effortLabel('custom', 'high')).toBe('high');
    expect(effortLabel(undefined, 'high')).toBe('high');
    expect(effortLabel('claude-code', 'minimal')).toBe('minimal');
    expect(permissionLabel('custom', 'auto')).toBe('auto');
    expect(permissionLabel('codex', 'nope')).toBe('nope');
  });
});
