// Measures how fast the built app feels and how much memory it uses, on the demo data with 20 tasks and 20 chats
// (one of 1,500 messages): `node scripts/perf/bench.mjs` in the Windows copy, after `npm run build`. Prints one JSON
// line per measurement and the medians. BENCH_RUNS: repeats (3). The other BENCH_ options are in lib.mjs and journey.mjs.
import { seeded } from './lib.mjs';
import { journey } from './journey.mjs';

const RUNS = Number(process.env.BENCH_RUNS || 3);

const results = {};
const record = (name, value) => {
  (results[name] ??= []).push(value);
  console.log(JSON.stringify({ name, ...value }));
};

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const chats = await seeded();
for (let i = 0; i < RUNS; i++) await journey(chats, record);
console.log('\nmedian of', RUNS, 'runs');
for (const [name, values] of Object.entries(results)) {
  const keys = Object.keys(values[0]).filter((k) => typeof values[0][k] === 'number');
  console.log(name.padEnd(30), keys.map((k) => `${k} ${median(values.map((v) => v[k]))}`).join('  '));
}
