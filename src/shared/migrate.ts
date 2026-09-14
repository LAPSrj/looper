/**
 * Definition-format versioning. One integer covers every place a task or
 * template definition is persisted: `.loopertask` / `.loopertpl` documents
 * ($version), tasks.json and templates.json (version). Bumped only on
 * breaking changes; additive changes (new optional fields) keep the number.
 *
 * This is the only kind of migration in this project: when the version
 * changes, a step is added here so a newer Looper can open every older file.
 * Nothing migrates downward — an older Looper refuses newer files.
 */

export const DEFINITION_VERSION = 2;

export type Definition = Record<string, unknown>;

/**
 * v1 -> v2: top-level `schedule` became `trigger` with a mode.
 *   schedule.enabled true  -> trigger.mode 'schedule'
 *   schedule.enabled false -> trigger.mode 'manual' (config kept)
 *   schedule.cron/timezone -> trigger.schedule
 *   schedule.stopOn        -> trigger.stopOn
 */
function v1ToV2(def: Definition): Definition {
  const { schedule, ...rest } = def as Definition & {
    schedule?: { enabled?: boolean; cron?: string; timezone?: string; stopOn?: unknown };
  };
  const trigger: Definition = { mode: schedule?.enabled === false ? 'manual' : 'schedule' };
  if (schedule && schedule.cron !== undefined) {
    trigger.schedule = {
      cron: schedule.cron,
      ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
    };
  }
  if (schedule?.stopOn !== undefined) trigger.stopOn = schedule.stopOn;
  return { ...rest, trigger };
}

/** Each step lifts a definition FROM its key's version to the next one. */
const STEPS: Record<number, (def: Definition) => Definition> = {
  1: v1ToV2,
};

/**
 * Lift a task/template definition from `from` to the current version.
 * Throws on a version this build has no path from (newer, or nonsense).
 */
export function migrateDefinition(def: Definition, from: number): Definition {
  if (from === DEFINITION_VERSION) return def;
  if (!Number.isInteger(from) || from < 1 || from > DEFINITION_VERSION) {
    throw new Error(`unknown definition format v${from} (this build reads v1..v${DEFINITION_VERSION})`);
  }
  let out = def;
  for (let v = from; v < DEFINITION_VERSION; v++) out = STEPS[v](out);
  return out;
}
