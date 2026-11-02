#!/usr/bin/env node
// A made-up addon for the docs screenshots: a "Servers" pane of invented
// servers, grouped by environment, with search, a filter, a server screen and
// an Edit window. Everything lives in memory and resets when it restarts.
// The protocol is in docs/addons.md.

import { createInterface } from 'node:readline';

const servers = [
  { id: 'web-1', name: 'web-1', env: 'Production', os: 'Linux', host: 'web-1.example.com', user: 'deploy', port: 22, password: 'demo-web-1', notes: 'Behind the load balancer.\nRestart nginx after a certificate renewal.' },
  { id: 'web-2', name: 'web-2', env: 'Production', os: 'Linux', host: 'web-2.example.com', user: 'deploy', port: 22, password: 'demo-web-2', notes: 'Behind the load balancer.' },
  { id: 'db-1', name: 'db-1', env: 'Production', os: 'Linux', host: 'db-1.example.com', user: 'postgres', port: 2222, password: 'demo-db-1', notes: 'Primary database.\nBackups run at 02:00.' },
  { id: 'build', name: 'build', env: 'Production', os: 'Windows', host: 'build.example.com', user: 'ci', port: 3389, password: 'demo-build', notes: '' },
  { id: 'stage-web', name: 'stage-web', env: 'Staging', os: 'Linux', host: 'stage.example.com', user: 'deploy', port: 22, password: 'demo-stage', notes: 'Rebuilt every night from main.' },
  { id: 'stage-db', name: 'stage-db', env: 'Staging', os: 'Linux', host: 'stage-db.example.com', user: 'postgres', port: 22, password: 'demo-stage-db', notes: '' },
  { id: 'dev-box', name: 'dev-box', env: 'Development', os: 'Windows', host: 'dev-box.example.com', user: 'dana', port: 3389, password: 'demo-dev', notes: '' },
];

/** The pane's filter: All, Linux or Windows. */
let show = 'All';

const find = (id) => {
  const s = servers.find((x) => x.id === id);
  if (!s) throw new Error('This server is no longer in the list.');
  return s;
};

const filterItems = () =>
  ['All', 'Linux', 'Windows'].map((o) => ({ id: `show:${o}`, label: `&${o}`, checked: show === o, radio: true }));

function pane() {
  return {
    items: servers
      .filter((s) => show === 'All' || s.os === show)
      .map((s) => ({
        id: s.id,
        label: s.name,
        description: `${s.user}@${s.host}`,
        group: s.env,
        keywords: s.os,
        view: 'server',
        params: { id: s.id },
        menu: [
          { id: 'copy-host', label: 'Copy &Host' },
          { id: 'copy-password', label: 'Copy &Password' },
          { separator: true },
          { id: 'edit', label: '&Edit Server…' },
        ],
      })),
    search: { placeholder: 'Search servers' },
    menu: [...filterItems(), { separator: true }, { id: 'new', label: '&New Server…' }],
    empty: 'No servers yet.',
    toolbar: [{ id: 'new', label: 'New Server…', icon: 'add' }],
    menuBar: [
      { label: '&File', items: [{ id: 'new', label: '&New Server…' }] },
      {
        label: '&Edit',
        items: [
          { id: 'edit', label: '&Edit Server…', needsItem: true },
          { separator: true },
          { id: 'copy-host', label: 'Copy &Host', needsItem: true },
          { id: 'copy-password', label: 'Copy &Password', needsItem: true },
        ],
      },
      { label: '&View', items: filterItems() },
    ],
  };
}

const field = (id, label, input, value, extra = {}) => ({ type: 'field', id, label, input, value, ...extra });

function render({ view, params }) {
  // The main window's Servers tab: every server by environment.
  if (view === 'overview') {
    return {
      title: 'Servers',
      toolbar: [{ id: 'new', label: 'New Server…', icon: 'add' }],
      body: ['Production', 'Staging', 'Development'].map((env) => ({
        type: 'section',
        title: env,
        body: [
          {
            type: 'props',
            items: servers.filter((s) => s.env === env).map((s) => ({ label: s.name, value: `${s.user}@${s.host}:${s.port} (${s.os})`, mono: true })),
          },
        ],
      })),
    };
  }
  if (view === 'server') {
    const s = find(params.id);
    return {
      title: s.name,
      toolbar: [{ id: 'edit', label: 'Edit Server…', icon: 'edit' }],
      body: [
        {
          type: 'props',
          items: [
            { label: 'Environment', value: s.env },
            { label: 'System', value: s.os },
            { label: 'Host', value: s.host, copy: true },
            { label: 'User', value: s.user, copy: true },
            { label: 'Password', secret: 'password' },
            { label: 'Port', value: String(s.port), mono: true },
          ],
        },
        ...(s.notes ? [{ type: 'section', title: 'Notes', body: [{ type: 'text', text: s.notes }] }] : []),
      ],
    };
  }
  if (view === 'edit' || view === 'new') {
    const s = view === 'edit' ? find(params.id) : { name: '', env: 'Production', os: 'Linux', host: '', user: '', port: 22, notes: '' };
    return {
      title: view === 'edit' ? `Edit ${s.name}` : 'New Server',
      body: [
        field('name', 'Name', 'text', s.name, { required: true, autofocus: true }),
        {
          type: 'row',
          items: [
            field('env', 'Environment', 'select', s.env, {
              options: ['Production', 'Staging', 'Development'].map((e) => ({ value: e, label: e })),
            }),
            field('os', 'System', 'select', s.os, { options: ['Linux', 'Windows'].map((o) => ({ value: o, label: o })) }),
          ],
        },
        field('host', 'Host', 'text', s.host, { required: true }),
        field('user', 'User', 'text', s.user),
        field('port', 'Port', 'number', s.port),
        field('key', 'Key file', 'file', '', { accept: [{ label: 'Key files', extensions: ['pem', 'key'] }] }),
        field('notes', 'Notes', 'textarea', s.notes),
        { type: 'footer', primary: { id: view === 'edit' ? 'save' : 'create', label: view === 'edit' ? 'Save' : 'Create' } },
      ],
    };
  }
  throw new Error(`Unknown screen "${view}".`);
}

function event(ev) {
  if (ev.id.startsWith('show:')) {
    show = ev.id.slice(5);
    return { actions: [{ type: 'refresh' }] };
  }
  const v = ev.values ?? {};
  const apply = (s) => Object.assign(s, { name: v.name, env: v.env, os: v.os, host: v.host, user: v.user, port: Number(v.port) || 22, notes: v.notes });
  switch (ev.id) {
    case 'new':
      return { actions: [{ type: 'openWindow', view: 'new', title: 'New Server', width: 520, height: 720 }] };
    case 'create': {
      const id = `server-${servers.length + 1}`;
      servers.push(apply({ id, password: '' }));
      return { actions: [{ type: 'closeWindow' }, { type: 'refresh' }, { type: 'select', pane: 'servers', item: id }] };
    }
    case 'save':
      apply(find(ev.source.params.id));
      return { actions: [{ type: 'closeWindow' }, { type: 'refresh' }] };
  }
  const s = find(ev.source.view ? ev.source.params.id : ev.item);
  switch (ev.id) {
    case 'edit':
      return { actions: [{ type: 'openWindow', view: 'edit', params: { id: s.id }, title: `Edit ${s.name}`, width: 520, height: 720 }] };
    case 'password':
      return { value: s.password };
    case 'copy-host':
      return { actions: [{ type: 'copy', text: s.host }] };
    case 'copy-password':
      return { actions: [{ type: 'copy', text: s.password }] };
  }
  if (ev.kind === 'open') {
    return { actions: [{ type: 'openWindow', view: 'edit', params: { id: s.id }, title: `Edit ${s.name}`, width: 520, height: 720 }] };
  }
  throw new Error(`Unknown action "${ev.id}".`);
}

const methods = { initialize: () => ({}), pane, render, event };
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
