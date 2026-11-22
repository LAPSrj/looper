// No imports and no DOM types: the unit tests (node tsconfig) load this file.

/** What an access key can be: a letter, then a digit. */
const KEYS = /[a-z0-9]/i;

/**
 * Unique access keys for a window's labels, in their order of priority (Win32 dialog boxes: "Whenever possible, assign
 * unique access keys to all interactive controls or their labels"). Each label takes the first letter of one of its
 * words that is still free, else any free letter or digit in it, else none (`key` ''). `index` is where that
 * character is in the label.
 */
export function assignAccessKeys(labels: readonly string[]): { key: string; index: number }[] {
  const taken = new Set<string>();
  const out = labels.map(() => ({ key: '', index: -1 }));
  const take = (i: number, index: number) => {
    const key = labels[i][index].toLowerCase();
    taken.add(key);
    out[i] = { key, index };
  };
  labels.forEach((label, i) => {
    for (const m of label.matchAll(/(^|[\s/(-])([a-z0-9])/gi)) {
      const index = m.index + m[1].length;
      if (!taken.has(label[index].toLowerCase())) return take(i, index);
    }
  });
  labels.forEach((label, i) => {
    if (out[i].key) return;
    for (let index = 0; index < label.length; index++) {
      if (KEYS.test(label[index]) && !taken.has(label[index].toLowerCase())) return take(i, index);
    }
  });
  return out;
}

/** The commit buttons that never take an access key: Enter and Esc are theirs (Win32 Command buttons). */
export const NO_ACCESS_KEY = new Set(['OK', 'Cancel', 'Close']);
