import { constants } from 'node:fs';
import { mkdir, rename, rm, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stackRoot } from '../local.mjs';
import { composeLiteral, composeResolved, writeJson } from '../recovery/bundle.mjs';
import { projectName } from '../recovery/docker.mjs';

export const installationDirectory = project => join(stackRoot, '.fogd', 'installations', projectName(project));

// Presence fences legacy fallback, including an interrupted first enrollment.
// This host directory never grants runtime authority; the policy volume does.
export async function hasRuntimeEnrollment(project) {
  try { await lstat(installationDirectory(project)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function writeRuntimeConfiguration(config, { reserve = false, recovery = false } = {}) {
  const dir = installationDirectory(config.name);
  for (const parent of [join(stackRoot, '.fogd'), join(stackRoot, '.fogd', 'installations')]) {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!(await lstat(parent)).isDirectory()) throw new Error('Installation state must be an ordinary host directory');
    await syncDirectory(join(parent, '..'));
  }
  try { await mkdir(dir, { recursive: !reserve, mode: 0o700 }); }
  catch (error) { if (reserve && error.code === 'EEXIST') throw new Error('Installation enrollment already exists; retain it and choose a fresh project'); throw error; }
  if (!(await lstat(dir)).isDirectory()) throw new Error('Installation state must be an ordinary host directory');
  await syncDirectory(join(dir, '..'));
  if (recovery) await writeJson(join(dir, 'restore.pending.json'), { project: config.name });
  const file = join(dir, 'compose.json'), temporary = join(dir, `compose-${randomUUID()}.pending.json`);
  try { await writeJson(temporary, composeLiteral(config)); await rename(temporary, file); await syncDirectory(dir); }
  finally { await rm(temporary, { force: true }); }
  return file;
}
async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}


export async function readRuntimeConfiguration(project) {
  const dir = installationDirectory(project);
  await assertRuntimeReady(project);
  try {
    for (const parent of [join(stackRoot, '.fogd'), join(stackRoot, '.fogd', 'installations'), dir]) {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || (stat.mode & 0o022)) throw new Error();
    }
    const file = await open(join(dir, 'compose.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024 || (stat.mode & 0o022)) throw new Error();
      const config = composeResolved(JSON.parse(await file.readFile()));
      if (config.name !== project) throw new Error();
      return config;
    } finally { await file.close(); }
  } catch { throw new Error('Cannot read the enrolled installation configuration; keep its resources stopped'); }
}


export async function assertRuntimeReady(project) {
  try { await lstat(join(installationDirectory(project), 'restore.pending.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Restoration is incomplete; keep the installation stopped and retain its data');
}

export async function completeRuntimeRestore(project) {
  const dir = installationDirectory(project);
  await rm(join(dir, 'restore.pending.json'));
  await syncDirectory(dir);
}
