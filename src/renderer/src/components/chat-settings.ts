import { autoCompactPercent, chatInteractive, type ChatSettingMenu, type ChatState } from '@shared/chat';
import { chatSettingEntries } from '@shared/chat-settings';
import { entriesMenu } from '@shared/commands/build';
import type { Entry } from '@shared/commands/command';
import { effortLabel, permissionLabel as permissionModeLabel } from '@shared/environments';

/** What the command bar names: a chat's settings, or a task run's (RunAgent). */
export type SettingsView = Pick<ChatState, 'harnessName' | 'harnessKind' | 'models' | 'settings' | 'activeModel'> & Partial<Pick<ChatState, 'autoCompactDefault'>>;

export const permissionLabel = (state: SettingsView): string =>
  permissionModeLabel(state.harnessKind, state.settings.permissionMode);

/** The harness, model, effort, permission mode, session type and auto compact as the command bar names them. */
export function settingLabels(state: SettingsView): Record<ChatSettingMenu, string> {
  const s = state.settings;
  const entry = state.models.find((m) => m.id === s.model);
  // As resolveEffort: the chat's own, else the model entry's default.
  const effort = s.effort ?? (s.model ? entry?.defaultEffort : undefined);
  return {
    harness: state.harnessName,
    model: entry?.name ?? s.model ?? state.activeModel ?? 'Default model',
    effort: effort ? effortLabel(state.harnessKind, effort) :'Default effort',
    permission: permissionLabel(state) || 'Default',
    mode: chatInteractive(state) ? 'Interactive' : 'Headless',
    compact: compactLabel(state),
  };
}

/** A task run has no auto compact (no autoCompactDefault): its bar leaves it out. */
function compactLabel(state: SettingsView): string {
  const percent = state.autoCompactDefault ? autoCompactPercent(state.settings, state.autoCompactDefault) : undefined;
  return percent === undefined ? 'No auto compact' : `Auto compact at ${percent}%`;
}

export const SETTING_TITLES = { harness: 'Harness', model: 'Model', effort: 'Effort', permission: 'Permission Mode', mode: 'Session Type', compact: 'Auto Compact' } as const;
export const SETTINGS = ['harness', 'model', 'effort', 'permission', 'mode', 'compact'] as const;

/** The settings a bar lists: a task run's leave out auto compact, which only a chat has. */
export const shownSettings = (state: SettingsView): readonly ChatSettingMenu[] => (state.autoCompactDefault ? SETTINGS : SETTINGS.filter((w) => w !== 'compact'));

/** A setting that can't change now: the harness once the chat has started and no other of its kind is there, any other once it has ended. */
export const settingDisabled = (state: ChatState, which: ChatSettingMenu): boolean =>
  which === 'harness' ? state.harnessLocked && !state.harnesses.some((h) => h.id !== state.harnessId && h.kind === state.harnessKind) : state.status === 'ended';

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
