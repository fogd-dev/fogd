import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeArgs } from '../../../packages/cli/src/recovery/docker.mjs';
import { selectedHostTrial } from './selected-trial.mjs';
import { copyFixture } from './project-copy.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { controllerState } from './observations.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { observationControl } from './observation-control.mjs';
import { stopSelectedHost } from './shutdown.mjs';

await selectedHostTrial(process.argv[2], 'Local-owner native observation: approved version, one stopped replica, stopped controller, recovery, pending-only app, and health-path handler trap. Disk metadata and native readiness only; no app-health, logging or controller-storage-health acceptance.', async context => {
  const { source: host, evidence } = context, request = await httpsClient(host);
  await waitFor('observation owner API', async () => (await request('/v1/admin')).status === 200);
  const token = (await host.json(['admin', 'issue-token', 'observation-builder', 'baseline,replacement'])).token;
  const fixture = { tokens: { builder: token }, secret: token };
  const project = await copyFixture(host, 'guestbook', 'observation-guestbook');
  const pending = await host.json(['deploy', '--name', 'baseline'], { cwd: project, env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, timeout: 240000 });
  context.phase = 'pending-observation'; evidence.pending = await unchangedObservation(host, 'baseline');
  assert.equal(evidence.pending.report.nativeReadiness, 'not-observed'); assert.equal(evidence.pending.report.controllerRecord, 'single-read');
  await host.json(['admin', 'approve', pending.id, pending.digest]);
  context.phase = 'active-observation'; evidence.active = await readyObservation(host, 'baseline');
  const state = await controllerState(host), slot = host.policy.fleets.find(value => value.id === state.apps.baseline.slot), peer = slot.nodes[1].host;
  context.phase = 'stopped-replica'; await ownCompose(host, ['stop', peer]);
  evidence.stoppedReplica = await unchangedObservation(host, 'baseline');
  assert.equal(evidence.stoppedReplica.report.nativeReadiness, 'uncertain'); assert.equal(evidence.stoppedReplica.report.runtimeIdentity, 'unconfirmed');
  assert.equal(evidence.stoppedReplica.report.replicas.find(row => row.node === peer).healthHTTPStatus, null);
  await ownCompose(host, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', peer]);
  context.phase = 'replica-recovery'; evidence.recoveredReplica = await readyObservation(host, 'baseline');
  context.phase = 'stopped-controller'; await ownCompose(host, ['stop', 'controller']);
  evidence.stoppedController = await unchangedObservation(host, 'baseline');
  assert.equal(evidence.stoppedController.report.nativeReadiness, 'uncertain'); assert.equal(evidence.stoppedController.report.controllerProcess, 'not-running');
  await ownCompose(host, ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'controller']);
  await waitFor('restarted observation controller', async () => (await request('/v1/admin')).status === 200);
  context.phase = 'controller-recovery'; evidence.recoveredController = await readyObservation(host, 'baseline');
  const messages = await request('/api/messages', { app: 'baseline' }); assert.equal(messages.status, 200); assert.deepEqual(messages.json(), []);
  evidence.baselineData = messages.json();
  context.phase = 'native-health-handler-boundary';
  const control = await observationControl(host, token);
  const before = await request('/counter', { app: 'replacement' }); assert.equal(before.status, 200); assert.deepEqual(before.json(), { hits: 0 });
  const unavailable = await request('/unavailable', { app: 'replacement' }); assert.equal(unavailable.status, 503);
  evidence.control = await readyObservation(host, 'replacement');
  const after = await request('/counter', { app: 'replacement' }); assert.equal(after.status, 200); assert.deepEqual(after.json(), before.json());
  evidence.healthBoundary = { before: before.json(), after: after.json(), appHTTPStatus: unavailable.status, nativeHealthStatuses: evidence.control.report.replicas.map(row => row.healthHTTPStatus) };
  assert.equal(evidence.control.report.applicationOutcomes, 'not-observed'); assert.equal(evidence.control.report.controllerStorageHealth, 'not-observed');
  assert.equal((await host.run('docker', ['ps', '-aq', '--filter', `label=fogd.observer.project=${host.project}`])).trim(), '');
  evidence.privacy = await scanPublicSurfaces(host, request, [pending, control], token, [], evidence);
  context.phase = 'clean-shutdown'; evidence.shutdown = await stopSelectedHost(host); host.closed = true;
  assert.equal(evidence.shutdown.retainedVolumes.length, 8);
  return fixture;
});
async function unchangedObservation(host, app) {
  const before = await controllerState(host);
  const report = await host.json(['observe', app, '--installation', host.project], { timeout: 90000 });
  const after = await controllerState(host);
  const sha = state => createHash('sha256').update(JSON.stringify(state)).digest('hex');
  const file = `observer-${randomUUID()}.json`;
  const observation = { report, beforeSha256: sha(before), afterSha256: sha(after), file };
  await writeFile(join(host.output, file), JSON.stringify({ stdout: JSON.stringify(observation), stderr: '' }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  assert.deepEqual(after, before); return observation;
}
async function readyObservation(host, app) {
  return waitFor(`confirmed native readiness for ${app}`, async () => {
    const observation = await unchangedObservation(host, app);
    return observation.report.nativeReadiness === 'confirmed' && observation;
  });
}

function ownCompose(host, args) {
  const file = join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json');
  return host.run('docker', [...composeArgs(file, host.project), ...args]);
}
