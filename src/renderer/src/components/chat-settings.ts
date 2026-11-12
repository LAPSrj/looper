import type { ChatSettingMenu, ChatState } from '@shared/chat';
import { chatSettingEntries } from '@shared/chat-settings';
import { entriesMenu } from '@shared/commands/build';
import type { Entry } from '@shared/commands/command';
import { EFFORT_LEVELS, PERMISSION_MODES } from '@shared/environments';

export const permissionLabel = (state: ChatState): string =>
  PERMISSION_MODES[state.harnessKind].find(([v]) => v === state.settings.permissionMode)?.[1] ?? state.settings.permissionMode;

/** The chat's harness, model, effort and permission mode as the command bar names them. */
export function settingLabels(state: ChatState): Record<ChatSettingMenu, string> {
  const s = state.settings;
  const entry = state.models.find((m) => m.id === s.model);
  // As resolveEffort: the chat's own, else the model entry's default.
  const effort = s.effort ?? (s.model ? entry?.defaultEffort : undefined);
  return {
    harness: state.harnessName,
    model: entry?.name ?? s.model ?? state.activeModel ?? 'Default model',
    effort: effort ? (EFFORT_LEVELS[state.harnessKind].find(([v]) => v === effort)?.[1] ?? effort) : 'Default effort',
    permission: permissionLabel(state) || 'Default',
  };
}

export const SETTING_TITLES = { harness: 'Harness', model: 'Model', effort: 'Effort', permission: 'Permission Mode' } as const;
export const SETTINGS = ['harness', 'model', 'effort', 'permission'] as const;

/** A setting that can't change now: the harness once the chat has started, any of them once it has ended. */
export const settingDisabled = (state: ChatState, which: ChatSettingMenu): boolean => (which === 'harness' ? state.harnessLocked : state.status === 'ended');

/** Open a setting's menu (or `all` of them) below `box`, the button it belongs to (a phone opens it out of the button). */
export function showSettingMenu(state: ChatState, which: ChatSettingMenu | 'all', box: DOMRect): void {
  const all = chatSettingEntries(state, window.looper);
  const entries: Entry[] =
    which === 'all'
      ? SETTINGS.map((k) => ({ id: k, label: SETTING_TITLES[k], entries: all[k].map((e) => ('separator' in e ? e : { ...e, id: `${k}-${e.id}` })) }))
      : all[which];
  const { items, pick } = entriesMenu('setting', entries);
  const button = { x: box.left, y: box.top, width: box.width, height: box.height };
  void window.looper.commands.popup(items, { x: box.left, y: box.bottom, button }).then((id) => id && pick(id));
}
