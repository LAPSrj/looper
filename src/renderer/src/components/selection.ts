/** A list's selection after the list changes: the same row while the list still has it, else its first row (null when it's empty). */
export function keptSelection<T, K>(selected: K | null, list: readonly T[], key: (item: T) => K): K | null {
  if (selected !== null && list.some((x) => key(x) === selected)) return selected;
  return list.length ? key(list[0]) : null;
}
