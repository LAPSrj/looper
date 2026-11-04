import { EventEmitter } from 'node:events';
import { sanitizeLayout, siblingOrder, validParent, type FolderLayout } from '../../shared/folders';
import { folderName, sameFolder, type ProjectAgent } from '../../shared/projects';
import { ProjectFolderSchema, type Environment, type Project, type ProjectFolder } from '../../shared/types';
import { validateProject } from '../../shared/validate';
import { readJson, writeJsonAtomic } from './fsutil';

interface ProjectsFile {
  projects: Project[];
  folders?: ProjectFolder[];
  layout?: FolderLayout;
}

/**
 * The projects, in the user's order, and the folders the Projects tab files
 * them in, which work as the task list's do: they nest, and each container's
 * folders and projects share one order (the layout). Emits `change` with the
 * project and what happened to it, `reorder`, and `folders` when the folders
 * or the layout change.
 */
export class ProjectStore extends EventEmitter {
  private projects = new Map<string, Project>();
  private folders: ProjectFolder[] = [];
  private layout: FolderLayout = {};

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
    this.folders = (data.folders ?? []).flatMap((f) => {
      const v = ProjectFolderSchema.safeParse(f);
      return v.success ? [v.data] : [];
    });
    this.layout = sanitizeLayout(data.layout);
    for (const raw of data.projects ?? []) {
      const v = validateProject(raw, this.environments(), this.host);
      if (v.ok) this.projects.set(v.project.id, v.project);
      else this.emit('invalid', raw, v.errors);
    }
    this.syncLayout();
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
    // Its folder changes only by moving it (reorder): an editor opened before a move would put it back.
    const { folderId: asked, ...fields } = v.project;
    const folderId = existing ? existing.folderId : asked && this.folders.some((f) => f.id === asked) ? asked : undefined;
    const project: Project = { ...fields, ...(folderId ? { folderId } : {}), createdAt: existing?.createdAt ?? v.project.createdAt ?? now, updatedAt: now };
    this.projects.set(project.id, project);
    this.syncLayout();
    this.save();
    this.emit('change', project, existing ? 'update' : 'create', existing);
    return project;
  }

  remove(id: string): boolean {
    const existing = this.projects.get(id);
    if (!existing) return false;
    this.projects.delete(id);
    this.syncLayout();
    this.save();
    this.emit('change', existing, 'remove');
    return true;
  }

  /**
   * Persist a new order (unknown ids are ignored; missing known ids keep their
   * relative order at the end), and, as the task list's drag and drop sends
   * them, the projects' new folders (null: the top level), the layout, and
   * folders' new parents. A folder that's gone, or a parent inside the
   * folder's own subtree, is left out.
   */
  reorder(ids: string[], folderById?: Record<string, string | null>, layout?: FolderLayout, parentById?: Record<string, string | null>): void {
    const next = new Map<string, Project>();
    for (const id of ids) {
      const p = this.projects.get(id);
      if (p) next.set(id, p);
    }
    for (const [id, p] of this.projects) if (!next.has(id)) next.set(id, p);
    this.projects = next;
    for (const [id, folderId] of Object.entries(folderById ?? {})) {
      const p = this.projects.get(id);
      if (!p || (folderId && !this.folders.some((f) => f.id === folderId))) continue;
      const { folderId: _old, ...rest } = p;
      this.projects.set(id, folderId ? { ...rest, folderId } : rest);
    }
    for (const [id, parentId] of Object.entries(parentById ?? {})) {
      const folder = this.folders.find((f) => f.id === id);
      const parent = validParent(this.folders, id, parentId);
      if (folder && parent !== null) folder.parentId = parent;
    }
    if (layout) this.layout = sanitizeLayout(layout);
    this.syncLayout();
    this.save();
    this.emit('reorder');
    this.emit('folders');
  }

  // ---------- folders ----------

  listFolders(): ProjectFolder[] {
    return this.folders.map((f) => ({ ...f }));
  }

  listLayout(): FolderLayout {
    return Object.fromEntries(Object.entries(this.layout).map(([k, v]) => [k, [...v]]));
  }

  /** A new folder, in `parentId` (unset: the top level), at its container's end. Throws with the reason. */
  addFolder(name: string, parentId?: string): ProjectFolder {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('folder name is empty');
    if (parentId && !this.folders.some((f) => f.id === parentId)) throw new Error('This folder no longer exists.');
    const folder: ProjectFolder = { id: Math.random().toString(36).slice(2, 10), name: trimmed, ...(parentId ? { parentId } : {}) };
    this.folders.push(folder);
    this.syncLayout();
    this.save();
    this.emit('folders');
    return { ...folder };
  }

  renameFolder(id: string, name: string): ProjectFolder {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('folder name is empty');
    const folder = this.folders.find((f) => f.id === id);
    if (!folder) throw new Error('This folder no longer exists.');
    folder.name = trimmed;
    this.save();
    this.emit('folders');
    return { ...folder };
  }

  /** Delete a folder: its folders and projects move up to its parent. */
  removeFolder(id: string): boolean {
    const removed = this.folders.find((f) => f.id === id);
    if (!removed) return false;
    this.folders = this.folders.filter((f) => f.id !== id);
    const parent = removed.parentId && this.folders.some((f) => f.id === removed.parentId) ? removed.parentId : undefined;
    for (const f of this.folders) if (f.parentId === id) f.parentId = parent;
    for (const [pid, p] of this.projects) {
      if (p.folderId !== id) continue;
      const { folderId: _gone, ...rest } = p;
      this.projects.set(pid, parent ? { ...rest, folderId: parent } : rest);
    }
    this.syncLayout();
    this.save();
    this.emit('folders');
    this.emit('reorder');
    return true;
  }

  /** Keep each container's order consistent with the folders and projects: stale entries drop out, new ones append. */
  private syncLayout(): void {
    this.layout = Object.fromEntries(siblingOrder(this.list(), this.folders, this.layout));
  }

  private save(): void {
    writeJsonAtomic(this.file, { projects: this.list(), folders: this.folders, layout: this.layout });
  }
}
