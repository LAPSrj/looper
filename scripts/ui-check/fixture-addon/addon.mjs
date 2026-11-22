// A made-up addon for `npm run ui-check` (scripts/ui-check/app.mjs installs it): a Passwords pane of a few hundred
// invented entries, grouped by site in 22 groups with three loose ones, with search. It sends only data, as a real addon does, so
// the check can tell a group drawn wrongly by Looper's shared pane code. Not the screenshots' demo data.
import { createInterface } from 'node:readline';

const SITES = ['100ways.com', 'acme.example', 'bank.example', 'cloud.example', 'docs.example', 'elm.example', 'forum.example', 'git.example', 'help.example', 'inbox.example', 'jobs.example', 'kiosk.example', 'lab.example', 'mail.example', 'news.example', 'office.example', 'photos.example', 'quiz.example', 'radio.example', 'shop.example', 'travel.example', 'video.example'];

const entries = [];
SITES.forEach((site, s) => {
  // Uneven groups: from 1 to 29 entries.
  const n = 1 + ((s * 7) % 29);
  for (let i = 0; i < n; i++) entries.push({ id: `e${s}-${i}`, site, user: `leandro+${site.split('.')[0]}${i || ''}@example.com` });
});
for (let i = 0; i < 3; i++) entries.push({ id: `loose-${i}`, site: '', user: `note-${i}@example.com` });

const pane = () => ({
  items: entries.map((e) => ({ id: e.id, label: e.user, description: e.site ? undefined : 'Not in a group', ...(e.site ? { group: e.site } : {}), view: 'entry', params: { id: e.id } })),
  search: { placeholder: 'Search passwords' },
  empty: 'No passwords yet.',
});

const render = ({ params }) => {
  const e = entries.find((x) => x.id === params.id);
  if (!e) throw new Error('This entry is gone.');
  return { title: e.user, body: [{ type: 'props', items: [{ label: 'Site', value: e.site || 'None' }, { label: 'User', value: e.user, copy: true }] }] };
};

const methods = { initialize: () => ({}), pane, render, event: () => ({}) };
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
createInterface({ input: process.stdin })
  .on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    try {
      send({ id: msg.id, result: methods[msg.method](msg.params ?? {}) });
    } catch (e) {
      send({ id: msg.id, error: { code: 1, message: e.message } });
    }
  })
  .on('close', () => process.exit(0));
