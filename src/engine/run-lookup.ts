import fs from 'node:fs';
import path from 'node:path';

/** The task a run, chat or terminal session ran under, from its folder in the data dir (tasks/<task>/runs/<run>). */
export async function findRunTask(dataDir: string, runId: string): Promise<string | undefined> {
  if (!/^[\w.@-]+$/.test(runId) || runId === '.' || runId === '..') throw new Error(`${runId} isn't a run id.`);
  const dir = path.join(dataDir, 'tasks');
  for (const taskId of await fs.promises.readdir(dir).catch(() => [] as string[])) {
    if (await fs.promises.access(path.join(dir, taskId, 'runs', runId)).then(() => true, () => false)) return taskId;
  }
  return undefined;
}
