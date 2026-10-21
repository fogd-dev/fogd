import { mkdir, rename, rm, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stackRoot } from '../local.mjs';
import { composeLiteral, writeJson } from '../recovery/bundle.mjs';
import { projectName } from '../recovery/docker.mjs';

const directory = project => join(stackRoot, '.fogd', 'installations', projectName(project));

// Presence fences legacy fallback, including an interrupted first enrollment.
// This host directory never grants runtime authority; the policy volume does.
export async function hasRuntimeEnrollment(project) {
  try { await lstat(directory(project)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function writeRuntimeConfiguration(config) {
  const dir = directory(config.name);
  for (const parent of [join(stackRoot, '.fogd'), join(stackRoot, '.fogd', 'installations'), dir]) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!(await lstat(parent)).isDirectory()) throw new Error('Installation state must be an ordinary host directory');
    await syncDirectory(join(parent, '..'));
  }
  const file = join(dir, 'compose.json'), temporary = join(dir, `compose-${randomUUID()}.pending.json`);
  try { await writeJson(temporary, composeLiteral(config)); await rename(temporary, file); await syncDirectory(dir); }
  finally { await rm(temporary, { force: true }); }
  return file;
}
async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
