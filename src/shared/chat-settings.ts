import type { LooperApi } from './api';
import { chatInteractive, type ChatSettingMenu, type ChatState } from './chat';
import { menuText, type Entry } from './commands/command';
import { EFFORT_LEVELS, PERMISSION_MODES, effortLabel } from './environments';

/** Menu items are in title case, like the rest of the menus ("Extra high" reads "Extra High"). */
const titled = (options: readonly (readonly [string, string])[]): [string, string][] => options.map(([value, label]) => [value, label.replace(/(^|\s)[a-z]/g, (m) => m.toUpperCase())]);

/** A radio list; a current value the list doesn't offer shows too, checked. */
function radioEntries(options: readonly (readonly [string, string])[], current: string, enabled: (value: string) => boolean, pick: (value: string) => void): Entry[] {
  const all = options.some(([v]) => v === current) ? options : [...options, [current, current] as const];
  return all.map(([value, label]) => ({ id: value || 'default', label: menuText(label), radio: true, checked: value === current, enabled: enabled(value), run: () => pick(value) }));
}

/** The session types a chat can run in, as the Session Type menu lists them. */
export const SESSION_TYPES = [
  ['interactive', 'Interactive'],
  ['headless', 'Headless'],
] as const;

/**
 * A chat's harness, model, effort, permission mode and session type, as a
 * menu's or the message box's choices. The harness changes only until the
 * first message. Claude replaces its process for a new model, effort, session
 * type or Bypass, which would cut a turn short, so those wait for the turn to
 * end; an interactive chat replaces it for a new permission mode too. Codex
 * runs headless only.
 */
export function chatSettingEntries(s: ChatState, looper: LooperApi): Record<ChatSettingMenu, Entry[]> {
  const ended = s.status === 'ended';
  const claude = s.harnessKind === 'claude-code';
  const busy = s.status === 'working' || s.status === 'starting' || s.permissions.length > 0;
  const canReplace = !ended && !(claude && busy);
  const entry = s.models.find((m) => m.id === s.settings.model);
  const levels = EFFORT_LEVELS[s.harnessKind];
  const offered = entry?.efforts ? levels.filter(([v]) => entry.efforts!.includes(v)) : levels;
  const defaultEffort = entry?.defaultEffort ? effortLabel(s.harnessKind, entry.defaultEffort) : undefined;
  // Interactive Claude Code takes a new permission mode only with a new process; Bypass needs one in either type.
  const bypassLive = s.settings.permissionMode === 'bypassPermissions' && !chatInteractive(s);
  const failed = (e: unknown) => void looper.showError((e as Error).message);
  const configure = (patch: Parameters<LooperApi['chat']['configure']>[1]) => void looper.chat.configure(s.id, patch).catch(failed);
  return {
    harness: radioEntries(s.harnesses.map((h) => [h.id, h.name] as const), s.harnessId, () => !s.harnessLocked, (id) => void looper.chat.setHarness(s.id, id).catch(failed)),
    model: radioEntries([['', 'Default'], ...s.models.map((m) => [m.id, m.name] as const)], s.settings.model ?? '', () => canReplace, (v) => configure({ model: v || undefined })),
    effort: radioEntries(titled([['', defaultEffort ? `Default (${defaultEffort})` : 'Default'], ...offered]), s.settings.effort ?? '', () => canReplace, (v) => configure({ effort: (v || undefined) as never })),
    permission: radioEntries(
      titled(PERMISSION_MODES[s.harnessKind]),
      s.settings.permissionMode,
      (v) => !ended && (chatInteractive(s) ? canReplace : v !== 'bypassPermissions' || bypassLive || canReplace),
      (v) => configure({ permissionMode: v as never }),
    ),
    // Claude Code goes on with a Code Mode conversation only in a terminal.
    mode: radioEntries(
      SESSION_TYPES,
      chatInteractive(s) ? 'interactive' : 'headless',
      (v) => canReplace && (v === 'headless' ? !s.codeMode : claude),
      (v) => configure({ mode: v as never }),
    ),
  };
}
