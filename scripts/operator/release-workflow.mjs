import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { writeFixtures } from '../capacity/write-workload.mjs';
import { waitFor } from '../cron-probe/selected/https.mjs';
import { privateNetworks } from '../cron-probe/selected/resources.mjs';
import { commandRunner } from '../cron-probe/selected/commands.mjs';
import { expectRefusal } from '../cron-probe/selected/evidence.mjs';
import { loadRecoveryTarget } from '../cron-probe/selected/recovery-target.mjs';
import { runtimePolicyIdentity } from '../../packages/platform/src/runtime-policy.mjs';
import { receivedCommands } from './release-host.mjs';

export async function receivedApplications(host, evidence, phase, client) {
  const exported = client || await host.json(['client', 'export', join(host.output, 'client')]);
  const clientDirectory = exported.directory || join(host.output, 'client');
  const { verifyClientFiles } = await import(join(host.program, 'packages/cli/src/distribution/bootstrap.mjs'));
  assert.equal(createHash('sha256').update(await readFile(join(clientDirectory, 'verify-client.mjs'))).digest('hex'), exported.bootstrapSha256);
  const verified = await verifyClientFiles(clientDirectory, exported.manifestSha256);
  host.client = join(clientDirectory, 'fogd.mjs'); evidence.client = { exported, verifiedFiles: Object.keys(verified.files).length };
  phase('received-client-deployments'); const f = await writeFixtures(host), peer = f.submissions[1];
  assert.equal((await f.request('/api/write-probe', { app: 'peer' })).status, 404);
  const peerApproval = await host.json(['admin', 'approve', peer.id, peer.digest]); assert.equal(peerApproval.status, 'active');
  for (const app of ['baseline', 'peer']) await acknowledgedWrite(f, app, `release-${app}`);
  evidence.beforeUpdate = await applicationRows(f);
  phase('pending-update-isolation');
  const project = join(host.output, 'write-baseline-source'), migration = '20261029000200_release_update.sql';
  await writeFile(join(project, 'db/migrations', migration), "CREATE TABLE release_markers(id TEXT PRIMARY KEY NOT NULL); INSERT INTO release_markers(id) VALUES ('v2');\n", { flag: 'wx', mode: 0o600 });
  await writeFile(join(project, 'routes/api/release.ts'), "import { defineHandler } from 'void';\nexport const GET=defineHandler(async c=>c.json((await c.env.DB.prepare('SELECT id FROM release_markers ORDER BY id').all()).results));\n", { flag: 'wx', mode: 0o600 });
  const update = await deploy(host, f, 'baseline', project); assert.equal(update.status, 'pending');
  assert.equal((await f.request('/api/release', { app: 'baseline' })).status, 404);
  evidence.pendingLedger = await nativeLedger(host, update); assert.deepEqual(evidence.pendingLedger.markerTables, []); assert.ok(!evidence.pendingLedger.applied.some(row => row.name === migration));
  assert.deepEqual(await applicationRows(f), evidence.beforeUpdate);
  phase('exact-update-approval'); const approval = await host.json(['admin', 'approve', update.id, update.digest]); assert.equal(approval.status, 'active');
  const release = await f.request('/api/release', { app: 'baseline' }); assert.equal(release.status, 200); assert.deepEqual(release.json(), [{ id: 'v2' }]);
  evidence.approvedLedger = await nativeLedger(host, update); assert.equal(evidence.approvedLedger.applied.filter(row => row.name === migration).length, 1);
  const peerProject = join(host.output, 'write-peer-source');
  await writeFile(join(peerProject, 'routes/api/pending-only.ts'), "import { defineHandler } from 'void'; export const GET=defineHandler(c=>c.json({executed:true}));\n", { flag: 'wx', mode: 0o600 });
  const pending = await deploy(host, f, 'peer', peerProject); assert.equal(pending.status, 'pending');
  assert.equal((await f.request('/api/pending-only', { app: 'peer' })).status, 404);
  evidence.approvals = { baseline: approval, peer: peerApproval }; evidence.pending = pending;
  phase('received-stop-and-restart'); await host.command(['stop', '--installation', host.project]); await host.command(['up', '--installation', host.project]);
  await waitFor('received restart admin', async () => (await f.request('/v1/admin')).status === 200);
  evidence.afterRestart = await releaseCheckpoint(host, f, evidence.beforeUpdate, pending);
  return f;
}

async function deploy(host, f, app, project) {
  const submitted = await host.json(['deploy', '--name', app], { env: { ...host.env, FOGD_DEPLOY_TOKEN: f.tokens.builder }, cwd: project }); f.submissions.push(submitted); return submitted;
}
export async function acknowledgedWrite(f, app, id) {
  const response = await f.request('/api/write-probe', { app, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  assert.equal(response.status, 200); assert.deepEqual(response.json(), { id, app });
}
export async function applicationRows(f) {
  const result = {};
  for (const app of ['baseline', 'peer']) { const response = await f.request('/api/write-probe', { app }); assert.equal(response.status, 200); result[app] = response.json(); }
  return result;
}
export async function releaseCheckpoint(host, f, expected, pending) {
  const rows = await applicationRows(f); assert.deepEqual(rows, expected);
  const release = await f.request('/api/release', { app: 'baseline' }), inert = await f.request('/api/pending-only', { app: 'peer' });
  assert.equal(release.status, 200); assert.deepEqual(release.json(), [{ id: 'v2' }]); assert.equal(inert.status, 404);
  const status = await host.json(['status', pending.id], { env: { ...host.env, FOGD_DEPLOY_TOKEN: f.tokens.builder } }); assert.equal(status.status, 'pending'); assert.equal(status.digest, pending.digest);
  return { rows, releaseStatus: release.status, releaseRows: release.json(), pendingRouteStatus: inert.status, pendingStatus: status.status, pendingDigest: status.digest };
}

export async function receivedRecovery(host, output, bundle, hosts) {
  await mkdir(output, { mode: 0o700 }); const project = `fogd-release-recovered-${randomBytes(8).toString('hex')}`, destination = join(output, 'planned');
  const env = { ...host.env, COMPOSE_PROJECT_NAME: project }, target = receivedCommands(host.program, { ...host, output, project, sourceProject: host.project, env, run: commandRunner(output, env), closed: false }); hosts.push(target);
  const networks = await privateNetworks(), networkFile = join(output, 'network-plan.json'); await writeFile(networkFile, JSON.stringify(networks) + '\n', { flag: 'wx', mode: 0o600 });
  const identity = runtimePolicyIdentity(host.policy);
  await target.command(['restore', bundle, '--project', project, '--output', destination, '--runtime', host.entry.id, '--expected-identity', identity, '--network-plan', networkFile], { timeout: 600000 });
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json')));
  await loadRecoveryTarget(host, target, destination, { ...host.policy, networks }, manifest.images);
  await target.command(['up', '--installation', project]);
  target.sourceFenceRefusal = await expectRefusal(host, ['up', '--installation', host.project], /Related installation .* is not confirmed stopped/);
  return target;
}

export async function nativeLedger(host, deployment) {
  const code = `import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{installedRuntimePolicy}from'/app/packages/platform/src/runtime-policy-file.mjs';import{selectedBackend}from'/app/packages/platform/src/startup.mjs';import{artifactDigest}from'/app/packages/runtime/src/artifact.mjs';
const s=JSON.parse(await readFile('/var/lib/fogd/state.json','utf8')),d=s.deployments[${JSON.stringify(deployment.id)}];assert.equal(d.app,'baseline');assert.equal(d.digest,${JSON.stringify(deployment.digest)});assert.equal(d.resources.d1.length,1);const artifact='/var/lib/fogd/artifacts/'+d.id;assert.equal(await artifactDigest(artifact),d.digest);const slot=JSON.parse(process.env.FOGD_SLOTS).find(v=>v.id===s.apps.baseline.slot);assert.ok(slot);const b=selectedBackend(undefined,await installedRuntimePolicy(process.env),process.env),q=async sql=>(await b.run(slot,['d1','execute',d.resources.d1[0].database_name,'--command',sql,artifact,'--json'])).trim().split('\\n').filter(Boolean).map(JSON.parse);console.log(JSON.stringify({applied:await q('SELECT name FROM d1_migrations ORDER BY name;'),markerTables:await q("SELECT name FROM sqlite_master WHERE type='table' AND name='release_markers';")}));`;
  return JSON.parse(await host.run('docker', ['exec', `${host.project}-controller-1`, '/usr/local/bin/node', '--input-type=module', '-e', code]));
}
