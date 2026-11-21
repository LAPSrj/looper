import { closeBuild, flag, liveOf, named, optText, runTaskOf, startBuild, text, type RequestHandler } from '../engine/cli-requests';
import type { Engine } from '../engine/engine';
import type { AddonHost } from './addon-host';
import { setAddonEnabled } from './addons';
import type { RemoteAccess } from './remote-access';

export interface MainRequestDeps {
  engine: () => Engine | null;
  addons: () => AddonHost | null;
  remoteAccess: () => RemoteAccess | null;
  showChat: (id: string) => void;
  showTask: (taskId: string) => void;
  showRun: (taskId: string, runId: string) => void;
  /** A window on the builder, unless one shows it already; `edit`: it edits a task. */
  showBuilder: (id: string, edit: boolean) => void;
  /** Close the builder's windows without asking to save. */
  closeBuilderWindows: (id: string) => void;
  logIn: (environmentId: string, harnessId: string) => void;
  /** Install a `.looperaddon` file, once the user agrees in the dialog that shows what it adds. */
  installAddon: (file: string) => Promise<void>;
  /** Quit as File → Exit does; `force`: as if the user had confirmed stopping the runs in progress. */
  quit: (force: boolean) => void;
}

/** The `looper` commands only the desktop app answers: its windows, addons and paired devices. */
export function mainCliRequests(d: MainRequestDeps): Record<string, RequestHandler> {
  const engine = (): Engine => {
    const e = d.engine();
    if (!e) throw new Error('Looper is still starting; try again in a moment.');
    return e;
  };
  const addons = (): AddonHost => {
    const a = d.addons();
    if (!a) throw new Error('Looper is still starting its addons; try again in a moment.');
    return a;
  };
  const addon = (id: string) => {
    const a = addons().list().find((x) => x.id === id);
    if (!a) throw new Error(`No addon has the id ${id}.`);
    return a;
  };
  const remoteAccess = (): RemoteAccess => {
    const r = d.remoteAccess();
    if (!r) throw new Error('Looper is still starting Remote Access; try again in a moment.');
    return r;
  };
  const device = (id: string) => {
    const dev = remoteAccess().state().devices.find((x) => x.id === id);
    if (!dev) throw new Error(`No paired device has the id ${id}.`);
    return dev;
  };

  return {
    quit: (p) => {
      const force = flag(p, 'force');
      // After the answer has gone out, since quitting closes the server that sends it.
      setTimeout(() => d.quit(force), 100);
      return force ? 'Looper is quitting, and stops any runs in progress.' : 'Looper is quitting; with runs in progress it asks first.';
    },
    open: async (p) => {
      const e = engine();
      const id = text(p, 'id');
      const t = liveOf(e, id);
      if (t?.kind === 'chat' || t?.kind === 'terminal') {
        d.showChat(id);
        return `Showed the ${named(t)}.`;
      }
      const task = e.getTask(id);
      if (task) {
        d.showTask(id);
        return `Showed "${task.name}".`;
      }
      const taskId = await runTaskOf(e, id);
      d.showRun(taskId, id);
      return `Showed the run ${id} of "${e.taskName(taskId) ?? taskId}".`;
    },

    'build-start': (p) => {
      const r = startBuild(engine(), p);
      d.showBuilder(r.id, r.edit);
      return `${r.message} Its window is open on the desktop.`;
    },
    'build-close': async (p) => {
      const closed = await closeBuild(engine(), p);
      d.closeBuilderWindows(text(p, 'id'));
      return closed;
    },

    login: (p) => {
      const e = engine();
      const harnessId = text(p, 'harnessId');
      const envId = optText(p, 'environmentId');
      const env = e.settings.environments.find((x) => (envId ? x.id === envId : x.harnesses.some((h) => h.id === harnessId)));
      if (!env?.harnesses.some((h) => h.id === harnessId)) throw new Error(`No harness has the id ${harnessId}${envId ? ` in the environment ${envId}` : ''}.`);
      d.logIn(env.id, harnessId);
      return 'Opened Log In.';
    },

    addons: () =>
      addons()
        .list()
        .map((a) => ({ id: a.id, name: a.name, version: a.version, enabled: a.enabled, status: a.status, ...(a.error ? { error: a.error } : {}) })),
    'addons-install': async (p) => {
      await d.installAddon(text(p, 'file'));
      return 'Opened the install dialog on the desktop.';
    },
    'addons-disable': (p) => {
      const a = addon(text(p, 'id'));
      setAddonEnabled(addons(), a.id, false);
      return `Turned off the addon "${a.name}".`;
    },
    'addons-enable': (p) => {
      const a = addon(text(p, 'id'));
      setAddonEnabled(addons(), a.id, true);
      return `Turned on the addon "${a.name}".`;
    },
    'addons-restart': (p) => {
      const a = addon(text(p, 'id'));
      addons().restart(a.id);
      return `Restarted the addon "${a.name}".`;
    },
    'addons-remove': async (p) => {
      const a = addon(text(p, 'id'));
      await addons().remove(a.id, true);
      return `Removed the addon "${a.name}".`;
    },

    devices: () => remoteAccess().state().devices,
    'devices-rename': async (p) => {
      const dev = device(text(p, 'id'));
      const name = text(p, 'name');
      await remoteAccess().renameDevice(dev.id, name);
      return `Renamed "${dev.name}" to "${name}".`;
    },
    'devices-remove': async (p) => {
      const dev = device(text(p, 'id'));
      await remoteAccess().removeDevice(dev.id);
      return `Removed "${dev.name}"; it has to pair again to reach Looper.`;
    },
    'devices-pair': () => remoteAccess().newPairingCode(),
  };
}
