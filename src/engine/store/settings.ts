import path from 'node:path';
import { SettingsSchema, type Settings } from '../../shared/types';
import { fileExists, readJson, writeJsonAtomic } from './fsutil';

export function loadSettings(dataDir: string): Settings {
  const file = path.join(dataDir, 'settings.json');
  const raw = readJson<unknown>(file, {});
  const parsed = SettingsSchema.safeParse(raw);
  const settings = parsed.success ? parsed.data : SettingsSchema.parse({});
  if (!fileExists(file)) writeJsonAtomic(file, settings);
  return settings;
}

export function saveSettings(dataDir: string, settings: Settings): Settings {
  const parsed = SettingsSchema.parse(settings);
  writeJsonAtomic(path.join(dataDir, 'settings.json'), parsed);
  return parsed;
}
