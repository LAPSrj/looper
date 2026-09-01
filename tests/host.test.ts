import { describe, expect, it } from 'vitest';
import { mountPrefixFromWslPath } from '../src/engine/host';

describe('mountPrefixFromWslPath', () => {
  it('extracts the automount root from wslpath output', () => {
    expect(mountPrefixFromWslPath('/mnt/c/\n')).toBe('/mnt');
    expect(mountPrefixFromWslPath('/mnt/c')).toBe('/mnt');
    expect(mountPrefixFromWslPath('/custom/drives/c/')).toBe('/custom/drives');
  });
  it('rejects anything that is not a drive mount path', () => {
    expect(mountPrefixFromWslPath('C:\\')).toBeUndefined();
    expect(mountPrefixFromWslPath('')).toBeUndefined();
    expect(mountPrefixFromWslPath('error: no such distro')).toBeUndefined();
  });
});
