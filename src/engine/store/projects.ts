import { EventEmitter } from 'node:events';
import { folderName, sameFolder, type ProjectAgent } from '../../shared/projects';
import type { Environment, Project } from '../../shared/types';
import { validateProject } from '../../shared/validate';
import { readJson, writeJsonAtomic } from './fsutil';

interface ProjectsFile {
  projects: Project[];
}

/** The projects, in the user's order. Emits `change` with the project and what happened to it. */
export class ProjectStore extends EventEmitter {
  private projects = new Map<string, Project>();

  constructor(
    private readonly file: string,
    private readonly environments: () => Environment[] | undefined,
    private readonly host?: string,
  ) {
    super();
  }

  load(): void {
    const data = readJson<ProjectsFile>(this.file, { projects: [] });
    this.projects.clear();
    for (const raw of data.projects ?? []) {
      const v = validateProject(raw, this.environments(), this.host);
      if (v.ok) this.projects.set(v.project.id, v.project);
      else this.emit('invalid', raw, v.errors);
    }
  }

  list(): Project[] {
    return [...this.projects.values()];
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /** The project of a folder in an environment. */
  find(environmentId: string, cwd: string): Project | undefined {
    return this.list().find((p) => p.environmentId === environmentId && sameFolder(p.cwd, cwd));
  }

  /** A new project's values for a folder: named after it, with a fresh id, and the given agent settings. */
  draft(environmentId: string, cwd: string, agent: Partial<ProjectAgent> = {}): Project {
    const name = folderName(cwd);
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
    let id = base;
    for (let n = 2; this.projects.has(id); n++) id = `${base}-${n}`;
    const { harnessId, model, effort, permissionMode = 'auto', mode = 'interactive' } = agent;
    return {
      id,
      name,
      environmentId,
      cwd,
      ...(harnessId ? { harnessId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      permissionMode,
      mode,
      extraArgs: [],
      env: {},
      remote: false,
    };
  }

  /** Validate and persist. Throws with the joined error list on invalid input or a folder another project has. */
  upsert(input: unknown): Project {
    const v = validateProject(input, this.environments(), this.host);
    if (!v.ok) throw new Error(v.errors.join('; '));
    const other = this.find(v.project.environmentId, v.project.cwd);
    if (other && other.id !== v.project.id) {
      throw new Error(`Working directory: the project "${other.name}" already has this folder in this environment`);
    }
    const now = new Date().toISOString();
    const existing = this.projects.get(v.project.id);
    const project: Project = { ...v.project, createdAt: existing?.createdAt ?? v.project.createdAt ?? now, updatedAt: now };
    this.projects.set(project.id, project);
    this.save();
    this.emit('change', project, existing ? 'update' : 'create', existing);
    return project;
  }

  remove(id: string): boolean {
    const existing = this.projects.get(id);
    if (!existing) return false;
    this.projects.delete(id);
    this.save();
    this.emit('change', existing, 'remove');
    return true;
  }

  /** Persist a new order. Unknown ids are ignored; missing known ids keep their relative order at the end. */
  reorder(ids: string[]): void {
    const next = new Map<string, Project>();
    for (const id of ids) {
      const p = this.projects.get(id);
      if (p) next.set(id, p);
    }
    for (const [id, p] of this.projects) if (!next.has(id)) next.set(id, p);
    this.projects = next;
    this.save();
    this.emit('reorder');
  }

  private save(): void {
    writeJsonAtomic(this.file, { projects: this.list() });
  }
}
