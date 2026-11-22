// The performance regression check: every screen in screens.mjs and the journey in journey.mjs, measured on the
// seeded demo data (20 tasks, 20 chats) and compared with budgets.json. Exits 1 when a screen goes over its budget,
// fails to draw, or throws. In the Windows copy, after `npm run build`:
//   node scripts/perf/check.mjs            check
//   node scripts/perf/check.mjs --update   write budgets.json from this run (after a change that's meant to cost more)
//   node scripts/perf/check.mjs --only "window: Settings,ios:"   only the screens whose kind and name contain one of these
//   node scripts/perf/check.mjs --device ipad,android-tablet     only these devices: desktop, iphone, ipad, android, android-tablet (all by default)
//   node scripts/perf/check.mjs --on-battery --energy-saver   measure on battery power or in energy saver, where it stops otherwise
//   node scripts/perf/check.mjs --visible                     the app's windows in front, with the focus (lib.mjs: quiet mode is the default)
// Timings wait for a quiet computer (machine.mjs); one over its budget is measured again up to 3 times and the lowest
// counts. Exits 1 when something is broken or over budget, 2 when it doesn't measure (battery, energy saver, a wrong
// --device), and 3 when everything else passed but a timing over budget was only ever measured on a busy computer.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Battery power and energy saver slow every frame, so a run in either would be held to budgets set at full speed.
const POWER_STATUS = `$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace Perf -Name Power -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct Status { public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag; public int BatteryLifeTime; public int BatteryFullLifeTime; } [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus(out Status s);'
$s = New-Object Perf.Power+Status
[void][Perf.Power]::GetSystemPowerStatus([ref]$s)
$s | ConvertTo-Json`;
const power = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(POWER_STATUS, 'utf16le').toString('base64')], { encoding: 'utf8' }));
const unconfirmed = [
  power.ACLineStatus === 0 && !process.argv.includes('--on-battery') && 'on battery power (--on-battery measures it anyway)',
  power.SystemStatusFlag === 1 && !process.argv.includes('--energy-saver') && 'in energy saver (--energy-saver measures it anyway)',
].filter(Boolean);
if (unconfirmed.length) {
  console.error(`Not measuring, because the computer is ${unconfirmed.join(' and ')}.`);
  process.exit(2);
}

process.env.BENCH_ROOT ||= path.join(os.tmpdir(), 'looper-perf-check');
process.env.BENCH_ADDONS = '1';
const { seeded, APP_DIR } = await import('./lib.mjs');
const { journey } = await import('./journey.mjs');
const { parseDevices } = await import('./screens.mjs');
const { measureScreens } = await import('./run-screens.mjs');
const { conditions, conditionText, closeMachine } = await import('./machine.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUDGETS = path.join(HERE, 'budgets.json');
const update = process.argv.includes('--update');
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';
let devices;
try {
  devices = parseDevices(process.argv.includes('--device') ? process.argv[process.argv.indexOf('--device') + 1] : '');
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const wanted = (name) => !only || only.toLowerCase().split(',').some((o) => name.toLowerCase().includes(o.trim()));

const budgets = fs.existsSync(BUDGETS) ? JSON.parse(fs.readFileSync(BUDGETS, 'utf8')) : {};
// A budget leaves room for the noise between runs: times double or 100 ms more (a window's first frame alone swings
// between 80 and 180 ms on battery saver), counts a fifth more, memory 15% more.
const budgetOf = (metric, v) => {
  if (metric === 'toEnd') return 0;
  if (/Ms$/.test(metric) && metric !== 'taskManagerMb') return Math.max(Math.round(v * 2), v + 100);
  if (metric === 'nodes') return Math.round(v * 1.2) + 20;
  if (metric === 'heapMb') return Math.round(v * 1.25 + 1);
  return Math.round(v * 1.15) + 2;
};
const metricKey = (k) => (k === 'worstFrame' ? 'worstFrameMs' : k === 'longest' ? 'longestMs' : k === 'worstMs' ? 'worstKeyMs' : k === 'mainFreeze' ? 'mainFreezeMs' : k);
/** Timings depend on how busy the computer is; counts and memory don't. */
const isTiming = (metric) => /Ms$/.test(metric);
/** Metrics added without budgets yet: printed, and checked once budgets.json has them. */
const UNBUDGETED = new Set(['mainThreadMs', 'scrollMainThreadMs', 'mainThreadProbeMs', 'scrollMainThreadProbeMs', 'windowHeapMb', 'windowRendererMb']);

const measured = {};
/** Each name's conditions, one per time its timings were measured. */
const attempts = new Map();
const noteAttempts = (names) => {
  for (const n of names) if (conditions.has(n)) (attempts.get(n) ?? attempts.set(n, []).get(n)).push(conditions.get(n));
};
/** A measurement again: the lower of each timing counts, and the counts and memory stay the first one's. */
const keepLowest = (name, values) => {
  const was = measured[name];
  if (!was) return void (measured[name] = values);
  for (const [k, v] of Object.entries(values)) if (isTiming(metricKey(k)) && typeof v === 'number' && !(v >= was[k])) was[k] = v;
};
/** The names with a timing over its budget, among `names`. */
const timingsOver = (names) => names.filter((n) => Object.entries(measured[n] ?? {}).some(([k, v]) => isTiming(metricKey(k)) && budgets[n]?.[metricKey(k)] !== undefined && v > budgets[n][metricKey(k)]));
const AGAIN = update ? 0 : 3;

const chats = await seeded();
const journeyKeys = ['worstFrame', 'longest', 'mainFreeze', 'taskManagerMb', 'privateMb', 'toEnd', 'worstMs'];
const runJourney = async () => {
  const steps = {};
  await journey(chats, (name, value) => (steps[name] = value));
  const names = [];
  for (const [name, v] of Object.entries(steps)) {
    const keep = Object.fromEntries(Object.entries(v).filter(([k, x]) => typeof x === 'number' && journeyKeys.includes(k)));
    keepLowest(`journey: ${name}`, keep);
    names.push(`journey: ${name}`);
    console.log(`journey: ${name}`, JSON.stringify(keep), conditionText(conditions.get(`journey: ${name}`)));
  }
  noteAttempts(names);
  return names;
};
// The journey first, on the data as seeded, and again right away for its steps over budget: the screens below turn
// on Remote Access and add a helper and a builder.
if (devices.includes('desktop') && (!only || wanted('journey:'))) {
  const names = await runJourney();
  for (let i = 1; i <= AGAIN && timingsOver(names).length; i++) {
    console.log(`\nmeasuring the journey again (${i}/${AGAIN}) for ${timingsOver(names).join(', ')}`);
    await runJourney();
  }
}
const broken = [];
const runScreens = async (want) => {
  const screens = await measureScreens({ devices, want, chats });
  for (const [name, values] of Object.entries(screens.measured)) keepLowest(name, values);
  noteAttempts(Object.keys(screens.measured));
  return screens;
};
const first = await runScreens(wanted);
broken.push(...first.broken);
const screenNames = Object.keys(first.measured);
for (let i = 1; i <= AGAIN && timingsOver(screenNames).length; i++) {
  const again = timingsOver(screenNames);
  console.log(`\nmeasuring again (${i}/${AGAIN}): ${again.join(', ')}`);
  await runScreens((name) => again.some((n) => n === name || n.startsWith(`${name.replace(/:$/, '')}: `)));
}
await closeMachine();

const over = [];
const busy = [];
const unbudgeted = [];
for (const [name, values] of Object.entries(measured)) {
  const tries = attempts.get(name) ?? [];
  const quiet = !tries.length || tries.some((c) => c.quiet);
  for (const [k, v] of Object.entries(values)) {
    const metric = metricKey(k);
    if (update) {
      (budgets[name] ??= {})[metric] = budgetOf(metric, v);
      continue;
    }
    const limit = budgets[name]?.[metric];
    if (limit === undefined) (UNBUDGETED.has(metric) ? unbudgeted : over).push(`${name}: no budget for ${metric}${UNBUDGETED.has(metric) ? '' : ' (run with --update)'}`);
    else if (v > limit && isTiming(metric) && !quiet) busy.push(`${name}: ${metric} ${v} over its budget of ${limit}, not measured: computer busy (CPU ${Math.min(...tries.map((c) => c.cpu))}%${tries.some((c) => /in use/.test(c.why ?? '')) ? ', in use' : ''})`);
    else if (v > limit) over.push(`${name}: ${metric} ${v} over its budget of ${limit}`);
  }
}
for (const [name, values] of Object.entries(measured)) console.log(name.padEnd(48), Object.entries(values).map(([k, v]) => `${metricKey(k)} ${v}`).join('  '), conditionText(conditions.get(name)));
if (update) {
  const sorted = Object.fromEntries(Object.entries(budgets).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(BUDGETS, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`\nwrote ${Object.keys(measured).length} budgets to ${path.relative(APP_DIR, BUDGETS)}`);
}
if (unbudgeted.length) console.log(`\n${unbudgeted.length} measurements of metrics without budgets yet (${[...UNBUDGETED].join(', ')})`);
for (const b of broken) console.log(`BROKEN  ${b}`);
for (const o of over) console.log(`OVER    ${o}`);
for (const b of busy) console.log(`BUSY    ${b}`);
const failed = broken.length || over.length;
console.log(failed ? `\nFAILED: ${broken.length} broken, ${over.length} over budget${busy.length ? `, ${busy.length} not measured` : ''}` : busy.length ? `\nNOT MEASURED: ${busy.length} timings over budget on a busy computer; everything else passed` : '\nPASSED');
process.exit(failed ? 1 : busy.length ? 3 : 0);
