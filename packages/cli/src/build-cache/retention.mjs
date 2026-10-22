import { appName } from '@fogd/runtime/artifact';
import { readdir, realpath, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheDirectory, exists, hash, identity, digest, uuid, jsonBytes, readPrivateJSON, privateJSON, syncDirectory } from './paths.mjs';
import { validRecord, retentionReason } from './policy.mjs';
import { buildTree } from './tree.mjs';
import { validatePlan, validateCandidate } from './schema.mjs';
import { pruneCandidate, unfinishedPrunes, resumePrune } from './operations.mjs';
import { withBuildLock } from './mutex.mjs';

export async function planBuilds(home, app, state, origin) {
  appName(app);
  const rows = [], directory = await cacheDirectory(home, ['build-cache', app]); let unmanaged = 0;
  if (directory) for (const id of (await readdir(directory)).sort()) {
    if (!uuid(id)) { unmanaged++; continue; }
    const root = join(directory, id), info = await exists(root);
    if (!info?.isDirectory() || info.isSymbolicLink()) { unmanaged++; continue; }
    rows.push(await plannedBuild(root, app, id, state, origin));
  }
  const legacy = await cacheDirectory(home, ['releases', app]);
  return { format: 'fogd-host-cache-plan-v1', home: hash(await realpath(home)), controller: hash(origin), app, rows,
    unmanagedEntriesKept: unmanaged, legacyEntriesKept: legacy ? (await readdir(legacy)).length : 0,
    unfinishedPrunes: await unfinishedPrunes(home, app),
    reclaimableLogicalBytes: rows.filter(row => row.decision === 'prune').reduce((sum, row) => sum + row.logicalBytes, 0) };
}
async function plannedBuild(root, app, id, state, origin) {
  const row = { app, id, decision: 'keep', reason: 'unsupported-local-metadata', logicalBytes: null };
  try {
    const { value: record } = await readPrivateJSON(join(root, 'record.json'));
    if (!validRecord(record, app, id)) return row;
    const kept = Boolean(await exists(join(root, 'keep'))), reason = retentionReason(record, state, origin, kept);
    row.reason = reason;
    const tree = await buildTree(root, reason === 'terminal-copy'); row.logicalBytes = tree.logicalBytes;
    if (reason !== 'terminal-copy') return row;
    if (tree.artifactDigest !== record.digest || tree.files.some(file => !file.path.startsWith('artifact/') && file.path !== 'record.json') || tree.directories.some(path => path !== 'artifact' && !path.startsWith('artifact/'))) return { ...row, reason: 'changed-build' };
    const candidate = { ...row, decision: 'prune', record, tree };
    try { validateCandidate(candidate); } catch { return { ...row, reason: 'changed-build' }; }
    return candidate;
  } catch { return { ...row, reason: row.reason === 'terminal-copy' ? 'unsupported-tree' : row.reason }; }
}
export async function saveBuildPlan(file, plan) {
  await privateJSON(file, plan);
  return hash(jsonBytes(plan));
}
export async function readBuildPlan(file, expected) {
  if (!digest(expected)) throw new Error('Supply the reviewed plan SHA-256 with --expected-plan');
  const { value, bytes } = await readPrivateJSON(file, 16 * 1024 ** 2);
  if (hash(bytes) !== expected) throw new Error('Build plan checksum differs from the reviewed plan');
  validatePlan(value); return value;
}
export async function applyBuildPlan(home, plan, origin, readState, planHash) {
  validatePlan(plan);
  if (!digest(planHash) || plan.home !== hash(await realpath(home)) || plan.controller !== hash(origin)) throw new Error('Build plan belongs to a different home or controller');
  let snapshot; const state = () => snapshot ||= readState();
  const results = [];
  for (const row of plan.rows.filter(row => row.decision === 'prune')) {
    try { results.push(await pruneCandidate(home, row, { home: plan.home, controller: plan.controller, planHash }, origin, state)); }
    catch (error) { results.push({ app: row.app, id: row.id, refused: true, reason: error.message }); }
  }
  return { app: plan.app, results, completedLogicalBytes: results.filter(row => row.completed).reduce((sum, row) => sum + row.logicalBytes, 0) };
}
export async function localBuilds(home, app) {
  appName(app); const directory = await cacheDirectory(home, ['build-cache', app]), builds = []; let unmanaged = 0;
  if (directory) for (const id of (await readdir(directory)).sort()) {
    if (!uuid(id)) { unmanaged++; continue; }
    try {
      const root = await cacheDirectory(home, ['build-cache', app, id]);
      const { value } = await readPrivateJSON(join(root, 'record.json'));
      if (!validRecord(value, app, id)) throw new Error('Unsupported record');
      builds.push({ app, id, phase: value.phase, submission: value.submission || null, retained: Boolean(await exists(join(root, 'keep'))) });
    } catch { builds.push({ app, id, phase: 'unrecognized', retained: true }); }
  }
  return { app, builds, unmanagedEntriesKept: unmanaged, unfinishedPrunes: await unfinishedPrunes(home, app) };
}
export { resumePrune };
export async function keepBuild(home, app, id, retain) {
  identity(app, id);
  return withBuildLock(home, app, id, async () => {
    const root = await cacheDirectory(home, ['build-cache', app, id]);
    if (!root) throw new Error('Build is absent or pruning has begun; no retention change was made');
    const file = join(root, 'keep'), old = await exists(file);
    if (old && (!old.isFile() || old.nlink !== 1n || old.isSymbolicLink())) throw new Error('Unsupported local keep marker');
    if (retain && !old) { const handle = await open(file, 'wx', 0o600); try { await handle.writeFile('kept\n'); await handle.sync(); } finally { await handle.close(); } }
    if (!retain && old) await unlink(file);
    await syncDirectory(root);
    return { app, id, retained: retain };
  });
}
