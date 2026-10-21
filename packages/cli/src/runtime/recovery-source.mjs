import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, readdir, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { installationDirectory } from './installation-state.mjs';
import { writeJson } from '../recovery/bundle.mjs';
import { projectName, stopped, volumeNames } from '../recovery/docker.mjs';

const filename = project => join(installationDirectory(project), 'recovery-source.json');

export async function writeRecoverySource(project, sourceProject, config) {
  const source = { schema: 1, project, sourceProject, volumes: volumeNames(config).map(name => config.volumes[name].name) };
  validateSource(source, project);
  const file = filename(project), temporary = join(installationDirectory(project), `recovery-source-${randomUUID()}.pending.json`);
  try {
    await writeJson(temporary, source);
    // Publishing a fully synced inode is atomic and refuses an existing record.
    await link(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  const directory = await open(installationDirectory(project), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

// These host records can only refuse startup. Related source, target and sibling
// projects must all be stopped; remote writers still need operator exclusion.
export async function assertRecoverySourceStopped(project) {
  const records = await recoverySources(project), related = relatedProjects(project, records);
  for (const peer of related) {
    if (peer === project) continue;
    const volumes = [...new Set(records.filter(record => record.sourceProject === peer).flatMap(record => record.volumes))];
    try { await stopped(peer, volumes); }
    catch (cause) { throw new Error(`Related installation ${peer} is not confirmed stopped: ${cause.message}`, { cause }); }
  }
}

function relatedProjects(project, records) {
  const edges = new Map();
  for (const { project: target, sourceProject: source } of records) {
    if (!edges.has(target)) edges.set(target, new Set());
    if (!edges.has(source)) edges.set(source, new Set());
    edges.get(target).add(source); edges.get(source).add(target);
  }
  const related = new Set([project]), pending = [project];
  while (pending.length) for (const peer of edges.get(pending.pop()) || []) {
    if (!related.has(peer)) { related.add(peer); pending.push(peer); }
  }
  return related;
}

async function recoverySources(project) {
  let entries;
  try { entries = await readdir(join(installationDirectory(project), '..'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(entry.name)) continue;
    const record = await readSource(entry.name);
    if (record) records.push(record);
  }
  return records;
}

async function readSource(project) {
  let file;
  try { file = await open(filename(project), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Cannot verify recovery source record for ${project}; keep related installations stopped`); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o022)) throw new Error();
    const source = JSON.parse(await file.readFile()); validateSource(source, project); return source;
  } catch { throw new Error(`Cannot verify recovery source record for ${project}; keep related installations stopped`); }
  finally { await file.close(); }
}

function validateSource(source, project) {
  projectName(project); projectName(source?.sourceProject);
  if (!source || !isDeepStrictEqual(Object.keys(source).sort(), ['project', 'schema', 'sourceProject', 'volumes']) ||
    source.schema !== 1 || source.project !== project || source.sourceProject === project || !Array.isArray(source.volumes) ||
    !source.volumes.length || source.volumes.length > 16 || new Set(source.volumes).size !== source.volumes.length ||
    source.volumes.some(name => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(name))) throw new Error('Invalid recovery source exclusion record');
}
