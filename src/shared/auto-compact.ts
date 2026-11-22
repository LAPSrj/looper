// Settings → Chats' auto compact share. Relative imports only, and none: the settings schema and the Settings window load it.

/** The range of the share of the context window (percent) a chat compacts past. */
export const AUTO_COMPACT_MIN = 10;
export const AUTO_COMPACT_MAX = 99;

/** A share typed or stepped in the Settings box, as a whole number within the range. */
export const clampAutoCompactPercent = (n: number): number => Math.min(AUTO_COMPACT_MAX, Math.max(AUTO_COMPACT_MIN, Math.round(n)));
