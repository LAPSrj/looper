// Measures how fast the built app feels and how much memory it uses, on the demo data with 20 tasks and 20 chats
// (one of 1,500 messages): `node scripts/perf/bench.mjs` in the Windows copy, after `npm run build`. Every screen of
// every device is measured BENCH_RUNS times (3), and the medians are printed by screen and metric, so a change is
// compared by running the same command before and after.
//   --device desktop,iphone,ipad,android,android-tablet   only these devices (all by default). The desktop is the journey,
//                                                         the windows and the main window's screens; a phone or tablet's
//                                                         screens are check.mjs's, with the steady scroll's frames.
//   --only "ios: Chat,window: Settings"                   only the screens whose name contains one of these
//   --visible                                             the app's windows in front, with the focus (quiet mode is the default, lib.mjs)
// Timings wait for a quiet computer first (machine.mjs); each line says what it was measured in, and each median how
// many of its runs were measured quietly.
// The journey's steps are named as in journey.mjs, the screens as in check.mjs ("window: Settings", "main: Chat",
// "ios: Chat", "ipad: Tasks"). Prints one JSON line per measurement. BENCH_RUNS: repeats (3). The other BENCH_ options
// are in lib.mjs and journey.mjs.
// The screens are measured with the demo's addon, as check.mjs does, so the journey's numbers here include it too.
process.env.BENCH_ADDONS ||= '1';
const { seeded } = await import('./lib.mjs');
const { journey } = await import('./journey.mjs');
const { parseDevices } = await import('./screens.mjs');
const { measureScreens } = await import('./run-screens.mjs');
const { conditions, closeMachine } = await import('./machine.mjs');

const RUNS = Number(process.env.BENCH_RUNS || 3);
const arg = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : '');
let devices;
try {
  devices = parseDevices(arg('--device'));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
const only = arg('--only');
const wanted = (name) => !only || only.toLowerCase().split(',').some((o) => name.toLowerCase().includes(o.trim()));

const results = {};
const quietRuns = {};
const broken = new Set();
const record = (name, value) => {
  (results[name] ??= []).push(value);
  // The journey's steps are recorded as it goes, so their conditions come after: they're printed with the medians.
  const c = conditions.get(name);
  if (c?.quiet) quietRuns[name] = (quietRuns[name] ?? 0) + 1;
  console.log(JSON.stringify({ name, ...value, ...(c ? { conditions: c } : {}) }));
};

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const chats = await seeded();
// The journey runs first, each time on the data as seeded: the screens turn on Remote Access and add a helper and a builder.
if (devices.includes('desktop') && (!only || wanted('journey:'))) for (let i = 0; i < RUNS; i++) {
    const steps = [];
    await journey(chats, (name, value) => {
      steps.push(name);
      record(name, value);
    });
    for (const name of steps) {
      const c = conditions.get(`journey: ${name}`);
      if (c?.quiet) quietRuns[name] = (quietRuns[name] ?? 0) + 1;
      if (c) console.log(JSON.stringify({ name, conditions: c }));
    }
  }
for (let i = 0; i < RUNS; i++) {
  const { measured, broken: failed } = await measureScreens({ devices, want: wanted, chats });
  for (const [name, values] of Object.entries(measured)) record(name, values);
  for (const b of failed) broken.add(b);
}
console.log('\nmedian of', RUNS, 'runs');
for (const [name, values] of Object.entries(results)) {
  const keys = [...new Set(values.flatMap((v) => Object.keys(v)))].filter((k) => values.some((v) => typeof v[k] === 'number'));
  console.log(name.padEnd(36), keys.map((k) => `${k} ${median(values.map((v) => v[k]).filter((x) => typeof x === 'number'))}`).join('  '), `[quiet ${quietRuns[name] ?? 0}/${values.length}]`);
}
await closeMachine();
for (const b of broken) console.log(`BROKEN  ${b}`);
process.exit(broken.size ? 1 : 0);
