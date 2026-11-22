import path from 'node:path';
import { SettingsSchema, defaultEnvironments, type Settings } from '../../shared/types';
import { fileExists, readJson, writeJsonAtomic } from './fsutil';

/** The tasks or templates file: the one Settings → Advanced names, or the data dir's own. */
export function storeFile(dataDir: string, store: 'tasks' | 'templates', settings: { tasksFile?: string; templatesFile?: string }): string {
  return (store === 'tasks' ? settings.tasksFile : settings.templatesFile) ?? path.join(dataDir, `${store}.json`);
}

/** The host decides the out-of-the-box environments (local shell + the reachable bridge). */
export function loadSettings(dataDir: string, host?: string): Settings {
  const file = path.join(dataDir, 'settings.json');
  const fresh = () =>
    SettingsSchema.parse({ environments: defaultEnvironments(host), defaultEnvironmentId: 'local' });
  if (!fileExists(file)) {
    const settings = fresh();
    writeJsonAtomic(file, settings);
    return settings;
  }
  const read = readJson<unknown>(file, {});
  const migrated = migrateSettings(read);
  if (migrated) writeJsonAtomic(file, migrated);
  const raw = migrated ?? read;
  const parsed = SettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : fresh();
}

/**
 * A settings file in an older shape, rewritten in the current one; null when it's current.
 *
 * - `view.toolbar`: one check for the main window's whole toolbar, before it
 *   became four toolbars (`view.toolbars`), which each take its value.
 */
export function migrateSettings(raw: unknown): Record<string, unknown> | null {
  if (!isObject(raw) || !isObject(raw.view) || !('toolbar' in raw.view)) return null;
  const { toolbar, ...view } = raw.view;
  const shown = toolbar !== false;
  const toolbars = isObject(view.toolbars) ? view.toolbars : {};
  return { ...raw, view: { ...view, toolbars: { new: shown, projects: shown, tasks: shown, chats: shown, ...toolbars } } };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function saveSettings(dataDir: string, settings: Settings): Settings {
  const parsed = SettingsSchema.parse(settings);
  writeJsonAtomic(path.join(dataDir, 'settings.json'), parsed);
  return parsed;
}
