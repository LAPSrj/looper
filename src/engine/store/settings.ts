import path from 'node:path';
import { SettingsSchema, defaultEnvironments, type Settings } from '../../shared/types';
import { fileExists, readJson, writeJsonAtomic } from './fsutil';

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
  const raw = readJson<unknown>(file, {});
  const parsed = SettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : fresh();
}

export function saveSettings(dataDir: string, settings: Settings): Settings {
  const parsed = SettingsSchema.parse(settings);
  writeJsonAtomic(path.join(dataDir, 'settings.json'), parsed);
  return parsed;
}
