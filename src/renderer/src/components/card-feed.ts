/** How long a card waits before reading its conversation again after a read that brought nothing, by attempt. */
export const CARD_RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

/**
 * A dashboard card's conversation while it shows it: read once (`read`), then kept current by its own events (`of`
 * picks them from what `subscribe` delivers), each new value passed to `set`. A read that brings nothing (a phone's
 * connection dropped, or Looper was still opening the chat) is tried again, CARD_RETRY_MS apart, until the conversation
 * comes, by a read or an event: otherwise the card showed only its last messages for good. Returns what stops it.
 */
export function followCard<T, E>(
  id: string,
  read: (id: string) => Promise<T | null>,
  of: (e: E, id: string) => T | undefined,
  subscribe: (fn: (e: E) => void) => () => void,
  set: (update: (prev: T | null) => T | null) => void,
): () => void {
  let current = true;
  let got = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const unsub = subscribe((e) => {
    const v = of(e, id);
    if (!v) return;
    got = true;
    set(() => v);
  });
  const again = (attempt: number) => {
    retry = setTimeout(() => load(attempt + 1), CARD_RETRY_MS[Math.min(attempt, CARD_RETRY_MS.length - 1)]);
  };
  const load = (attempt: number) => {
    void read(id).then(
      (v) => {
        if (!current || got) return;
        if (!v) return again(attempt);
        got = true;
        // An event that came first is newer than what was read.
        set((prev) => prev ?? v);
      },
      (err: unknown) => {
        if (current && !got) again(attempt);
      },
    );
  };
  load(0);
  return () => {
    current = false;
    clearTimeout(retry);
    unsub();
  };
}
