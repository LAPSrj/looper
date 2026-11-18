/**
 * Claude Code arguments a user gives a harness, a task or a project, against
 * the ones Looper passes itself. Claude Code keeps only the last `--settings`
 * and the last `--append-system-prompt`, so Looper takes the user's out and
 * merges them into its own; a flag Looper sets, or one a Looper field sets,
 * is refused when the user saves.
 */

/** Flags Looper sets on every Claude Code session it starts. */
const LOOPER_FLAGS = ['-p', '--print', '--output-format', '--input-format', '--resume', '-r', '--session-id', '--continue', '-c', '--fork-session'];

/** Flags a Looper field sets, with that field's name. */
const FIELD_FLAGS: Record<string, string> = {
  '--model': 'Model',
  '--effort': 'Effort',
  '--permission-mode': 'Permission mode',
  '--dangerously-skip-permissions': 'Permission mode',
};

/** Flags that keep Looper's mod or hooks from loading. */
const UNLOADING_FLAGS: Record<string, string> = {
  '--bare': "it loads no plugin's hooks, so Looper's mod can't run",
  '--safe-mode': 'it turns off hooks and plugins, which Looper needs',
};

/** The flag name of an argument: `--settings=x` is `--settings`. */
const flagOf = (arg: string): string => (arg.startsWith('--') ? arg.split('=', 1)[0] : arg);

/**
 * The values of every `--settings X` and `--settings=X` in `args`, in order,
 * and the arguments left without them. `flag` names another flag that takes
 * one value (`--append-system-prompt`).
 */
export function takeFlagValues(args: readonly string[], flag = '--settings'): { values: string[]; rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      if (i + 1 < args.length) values.push(args[++i]);
    } else if (arg.startsWith(flag + '=')) {
      values.push(arg.slice(flag.length + 1));
    } else {
      rest.push(arg);
    }
  }
  return { values, rest };
}

/**
 * Why Claude Code `args` can't be saved (as `label`), or null. A `--settings`
 * value given as JSON must parse; a file one is read when a session starts.
 */
export function claudeArgsProblem(args: readonly string[], label: string): string | null {
  for (const arg of args) {
    const flag = flagOf(arg);
    if (LOOPER_FLAGS.includes(flag)) return `${label}: Looper sets ${flag} itself. Remove it.`;
    const field = FIELD_FLAGS[flag];
    if (field) return `${label}: ${flag} has a field of its own. Remove it and set ${field} instead.`;
    const why = UNLOADING_FLAGS[flag];
    if (why) return `${label}: Looper can't run Claude Code with ${flag}, because ${why}.`;
  }
  for (const value of takeFlagValues(args).values) {
    if (!value.trim().startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `${label}: the JSON after --settings must be an object.`;
    } catch (e) {
      return `${label}: the JSON after --settings isn't valid (${(e as Error).message}).`;
    }
  }
  return null;
}
