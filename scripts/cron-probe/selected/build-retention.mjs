import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { cp, readFile, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHostTrial } from './selected-trial.mjs';
import { copyFixture } from './project-copy.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { approvedArtifacts } from './observations.mjs';
import { publicTarget } from './public-target.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { buildTree } from '../../../packages/cli/src/build-cache/tree.mjs';
import { hash } from '../../../packages/cli/src/build-cache/paths.mjs';
import { verifyBundle } from '../../../packages/cli/src/recovery/bundle.mjs';
import { snapshotState } from '../../../packages/cli/src/recovery/snapshot-state.mjs';

await selectedHostTrial(process.argv[2], 'Explicit host build-copy retention on a new local two-fleet installation. Interrupted deletion, concurrent approval and stopped backup, offline journal resume, subsequent deployment and fresh-volume restore. No controller-artifact deletion or quota-fill acceptance.', async context => {
  const { source: host, evidence } = context, request = await httpsClient(host);
  await waitFor('retention owner API', async () => (await request('/v1/admin')).status === 200);
  const token = (await host.json(['admin', 'issue-token', 'retention-builder', 'baseline'])).token;
  const fixture = { tokens: { builder: token }, secret: token };
  context.phase = 'retention-fixtures';
  const builds = await prepareBuilds(host, request, token); evidence.builds = builds;
  context.phase = 'interrupted-prune-and-backup';
  const point = await pruneAndBackup(host, request, builds, evidence);
  context.phase = 'deploy-after-host-prune';
  await host.command(['up', '--installation', host.project]);
  await waitFor('restarted source', async () => (await request('/v1/admin')).status === 200);
  evidence.restartedLeases = await readyLeases(host);
  evidence.restartedApplication = await waitFor('restarted application routing and SQL', () => assertApplication(request, 'pending-c'));
  evidence.sourceArtifactsAfter = await approvedArtifacts(host, builds.releases);
  assert.deepEqual(evidence.sourceArtifactsAfter, evidence.sourceArtifactsBefore);
  const next = await deployVersion(host, token, builds.project, 'after-prune'); evidence.afterPrune = next;
  await host.json(['admin', 'approve', next.id, next.digest]); await assertApplication(request, 'after-prune');
  evidence.sourcePrivacy = await scanPublicSurfaces(host, request, [...Object.values(builds.releases), next], token, [], evidence);
  evidence.sourceShutdown = await stopSelectedHost(host); host.closed = true;
  context.phase = 'restore-retained-point';
  const target = await publicTarget(host, point, join(host.output, 'recovery'), context.installations);
  await target.command(['up', '--installation', target.project]);
  const restored = await httpsClient(target);
  await waitFor('restored source', async () => (await restored('/v1/admin')).status === 200);
  evidence.restoredArtifacts = await approvedArtifacts(target, builds.releases);
  assert.deepEqual(evidence.restoredArtifacts, evidence.sourceArtifactsBefore);
  evidence.restoredLeases = await readyLeases(target);
  evidence.restoredApplication = await waitFor('restored application routing and SQL', () => assertApplication(restored, 'pending-c'));
  const state = (await restored('/v1/admin')).json();
  assert.equal(state.apps.baseline.active, builds.releases.c.id);
  assert.equal(state.deployments[next.id], undefined);
  evidence.restored = { active: state.apps.baseline.active, rejected: state.deployments[builds.releases.d.id].status };
  evidence.targetPrivacy = await scanPublicSurfaces(target, restored, Object.values(builds.releases), token, [], evidence);
  evidence.targetShutdown = await stopSelectedHost(target); target.closed = true;
  assert.equal(evidence.sourceShutdown.retainedVolumes.length, 8); assert.equal(evidence.targetShutdown.retainedVolumes.length, 8);
  return fixture;
});

async function deployVersion(host, token, project, version) {
  await writeFile(join(project, 'routes/api/hello.ts'), `import {defineHandler} from 'void';\nexport const GET=defineHandler(()=>({version:${JSON.stringify(version)}}));\n`);
  return host.json(['deploy', '--name', 'baseline'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: project, timeout: 240000 });
}
async function prepareBuilds(host, request, token) {
  const project = await copyFixture(host, 'guestbook', 'retention-guestbook');
  const migration = join(project, 'db/migrations/20261016160656_complete_ser_duncan.sql');
  await writeFile(migration, (await readFile(migration, 'utf8')) + "\nINSERT INTO messages(id,text,created_at) VALUES(1,'retention-preserved-row','2026-10-22 12:00:00');\n");
  const a = await deployVersion(host, token, project, 'old-a'); await host.json(['admin', 'approve', a.id, a.digest]);
  const b = await deployVersion(host, token, project, 'active-b'); await host.json(['admin', 'approve', b.id, b.digest]);
  const c = await deployVersion(host, token, project, 'pending-c');
  const d = await deployVersion(host, token, project, 'kept-d'); await host.json(['admin', 'reject', d.id, d.digest]);
  await host.json(['builds', 'keep', 'baseline', d.localBuildId]); await assertApplication(request, 'active-b');
  const releases = { a, b, c, d }; assert.equal(new Set(Object.values(releases).map(value => value.digest)).size, 4);
  return { project, releases };
}
async function assertApplication(request, version) {
  const hello = await request('/api/hello', { app: 'baseline' }); assert.equal(hello.status, 200); assert.deepEqual(hello.json(), { version });
  const data = await request('/api/messages', { app: 'baseline' }); assert.equal(data.status, 200);
  assert.equal(data.json().length, 1); assert.equal(data.json()[0].text, 'retention-preserved-row');
  return { version: hello.json().version, rows: data.json() };
}
async function trees(host, releases) {
  const result = {};
  for (const [key, release] of Object.entries(releases)) result[key] = await buildTree(join(host.env.FOGD_HOME, '.fogd/build-cache/baseline', release.localBuildId), true);
  return result;
}
async function pausedPruner(host, file, checksum) {
  const child = fork(new URL('./retention-interrupt.mjs', import.meta.url), [host.env.FOGD_HOME, file, checksum], { env: host.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(([code, signal]) => { throw new Error(`Pruner exited before interruption: ${code}/${signal}: ${stderr}`); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Pruner pause timed out')), 20000); timer.unref(); })]);
    return child;
  } catch (error) { child.kill('SIGKILL'); throw error; }
}
async function pruneAndBackup(host, request, builds, evidence) {
  const { a, b, c, d } = builds.releases, file = join(host.output, 'approved-host-prune.json');
  evidence.sourceArtifactsBefore = await approvedArtifacts(host, builds.releases);
  evidence.protectedBefore = await trees(host, { b, c, d });
  // Preserve every qualification byte independently before deleting this disposable cache copy.
  const archive = join(host.output, 'archived-cache-a');
  await cp(join(host.env.FOGD_HOME, '.fogd/build-cache/baseline', a.localBuildId), archive, { recursive: true, errorOnExist: true, force: false });
  evidence.cacheArchive = await buildTree(archive, true); assert.equal(evidence.cacheArchive.artifactDigest, a.digest);
  const preview = await host.json(['builds', 'plan', 'baseline', '--output', file]); evidence.preview = preview;
  assert.deepEqual(preview.builds.filter(row => row.decision === 'prune').map(row => row.id), [a.localBuildId]);
  const checksum = hash(await readFile(file)); assert.equal(checksum, preview.sha256);
  const child = await pausedPruner(host, file, checksum);
  let exited;
  try {
    await host.json(['admin', 'approve', c.id, c.digest]); await assertApplication(request, 'pending-c');
    const bundle = join(host.output, 'retained-recovery-point');
    await host.command(['backup', bundle], { timeout: 300000 });
    const verified = await verifyBundle(bundle), archived = await snapshotState(bundle);
    assert.equal(archived.apps.baseline.active, c.id);
    assert.equal(archived.deployments[a.id].status, 'superseded'); assert.equal(archived.deployments[d.id].status, 'rejected');
    exited = once(child, 'exit'); child.kill('SIGKILL'); assert.deepEqual(await exited, [null, 'SIGKILL']);
    evidence.prunerExit = { code: child.exitCode, signal: child.signalCode };
    await unlink(file);
    evidence.unfinished = await host.json(['builds', 'list', 'baseline']);
    const unfinished = evidence.unfinished.unfinishedPrunes[0];
    assert.equal(unfinished.journalAvailable, true); assert.equal(unfinished.id, a.localBuildId);
    assert.ok(unfinished.logicalBytesRemaining > 0 && unfinished.logicalBytesRemaining < evidence.cacheArchive.logicalBytes);
    await assert.rejects(stat(join(host.env.FOGD_HOME, '.fogd/build-cache/baseline', a.localBuildId)), { code: 'ENOENT' });
    evidence.resumed = await host.json(['builds', 'resume', 'baseline', a.localBuildId]); assert.equal(evidence.resumed.completed, true); assert.equal(evidence.resumed.resumed, true);
    assert.ok(!(await host.json(['builds', 'list', 'baseline'])).builds.some(row => row.id === a.localBuildId));
    assert.deepEqual(await readdir(join(host.env.FOGD_HOME, '.fogd/build-trash/baseline')), []);
    evidence.protectedAfter = await trees(host, { b, c, d }); assert.deepEqual(evidence.protectedAfter, evidence.protectedBefore);
    return { bundle, manifest: verified.manifest, retiredHistory: {}, approvals: { baseline: c } };
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; }
  }
}

async function readyLeases(host) {
  const code = `
import{readFile}from'node:fs/promises';
import{installedRuntimePolicy}from'/app/packages/platform/src/runtime-policy-file.mjs';
import{selectedBackend}from'/app/packages/platform/src/startup.mjs';
import{backendRuntimeIdentity}from'/app/packages/platform/src/backend-runtime-identity.mjs';
const env=process.env,policy=await installedRuntimePolicy(env),backend=selectedBackend(undefined,policy,env);
const state=JSON.parse(await readFile('/var/lib/fogd/state.json','utf8'));
const slot=JSON.parse(env.FOGD_SLOTS).find(slot=>slot.id===state.apps.baseline.slot);
if(!slot)throw Error('Application fleet is absent');
const identity=backendRuntimeIdentity(backend,policy);await identity.verify(slot);
const leases=await identity.members(slot),observedAt=Date.now();
if(leases.length!==slot.nodes.length||leases.some(row=>row.expiresMs<=observedAt))throw Error('Fleet leases are not ready');
console.log(JSON.stringify({slot:slot.id,observedAt,leases:leases.map(({node,expiresMs})=>({node,expiresMs}))}));`;
  return waitFor('all assigned native leases and signed process identities', async () => JSON.parse(await host.run('docker', ['exec', `${host.project}-controller-1`, '/usr/local/bin/node', '--input-type=module', '-e', code])));
}
