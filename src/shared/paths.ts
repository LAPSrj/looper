const withoutTrailing = (p: string): string => p.replace(/[\\/]+$/, '');

/** A path's last part, for a Windows or POSIX path, ignoring trailing separators; a path of only separators comes back as it is. */
export function baseName(p: string): string {
  return withoutTrailing(p).split(/[\\/]/).pop() || p;
}

/** The path without its last part, for a Windows or POSIX path, ignoring trailing separators; '' when there's no folder part. */
export function dirName(p: string): string {
  const t = withoutTrailing(p);
  const i = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  return i < 0 ? '' : withoutTrailing(t.slice(0, i));
}
