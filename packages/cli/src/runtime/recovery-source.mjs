import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { open, readdir, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hasRuntimeEnrollment, installationDirectory, readInstallationVolumeNames } from './installation-state.mjs';
import { writeJson } from '../recovery/bundle.mjs';
import { projectName, stopped } from '../recovery/docker.mjs';
import { installationVolumeNames } from './installation-volumes.mjs';
import { assertNoLaunchFence } from './launch-fence.mjs';

const filename = project => join(installationDirectory(project), 'recovery-source.json');

export async function writeRecoverySource(project, sourceProject, config) {
  return publishSource(project, { schema: 1, project, sourceProject, volumes: installationVolumeNames(config) });
}

// One atomic host record binds both current and retained sources before target
// allocation. Publishing separate records could leave a partially excluded graph.
export async function writeRecoverySources(project, sources) {
  const record = { schema: 2, project, sources: sources.map(source => ({ sourceProject: source.project, volumes: installationVolumeNames(source.config) })) };
  return publishSource(project, record);
}
async function publishSource(project, source) {
  sourceRecords(source, project);
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
    try {
      const sourceVolumes = records.filter(record => record.sourceProject === peer).flatMap(record => record.volumes);
      const enrolled = records.some(record => record.project === peer) || await hasRuntimeEnrollment(peer);
      const enrolledVolumes = enrolled ? await readInstallationVolumeNames(peer) : [];
      await stopped(peer, [...new Set([...sourceVolumes, ...enrolledVolumes])]);
    }
    catch (cause) { throw new Error(`Related installation ${peer} is not confirmed stopped: ${cause.message}`, { cause }); }
  }
}

// Each operation publishes its own fences before observing its recovery peers.
// Only fences actually acquired by this caller may be excluded from the check.
export async function assertRecoveryOperationsAvailable(project, ownedProjects = []) {
  projectName(project);
  const owned = new Set(ownedProjects);
  const peers = relatedProjects(project, await recoverySources(project));
  for (const peer of peers) if (!owned.has(peer)) await assertNoLaunchFence(installationDirectory(peer));
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
    if (record) records.push(...record);
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
    return sourceRecords(JSON.parse(await file.readFile()), project);
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

function sourceRecords(source, project) {
  if (source?.schema === 1) { validateSource(source, project); return [source]; }
  if (!source || !isDeepStrictEqual(Object.keys(source).sort(), ['project', 'schema', 'sources']) || source.schema !== 2 || source.project !== project ||
    !Array.isArray(source.sources) || source.sources.length !== 2 || new Set(source.sources.map(value => value.sourceProject)).size !== 2) throw new Error('Invalid recovery source exclusion record');
  return source.sources.map(value => {
    if (!value || !isDeepStrictEqual(Object.keys(value).sort(), ['sourceProject', 'volumes'])) throw new Error('Invalid recovery source exclusion record');
    const record = { schema: 1, project, ...value }; validateSource(record, project); return record;
  });
}
