import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareBackgroundFixtures, importJob } from './background-fixtures.mjs';
import { copyFixture } from './project-copy.mjs';
import { controllerState, nativeObservation, vmTime } from './observations.mjs';
import { expectRefusal } from './evidence.mjs';
import { applicationData, recoveredData } from './recovery-fixtures.mjs';
import { heldDataInterval } from './recovery-interval.mjs';
import { armedTimer } from './recovery-work.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { pauseFailureWork } from './failure-phases.mjs';
import { rows } from './recovery-ledger.mjs';
import { waitFor } from './https.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { ownCompose } from '../../capacity/serving-host.mjs';
import { verifyDurableBundle } from '../../../packages/cli/src/recovery/durable-bundle.mjs';

export async function pendingLifecycle(host) {
  const fixture = await prepareBackgroundFixtures(host), importsProject = await copyFixture(host, 'imports', 'imports-source');
  const queued = await host.json(['deploy', '--name', 'imports'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: fixture.tokens.imports }, cwd: importsProject });
  assert.equal(fixture.submitted.status, 'pending'); assert.equal(queued.status, 'pending');
  return { ...fixture, queued, importsProject, approvals: {}, submissions: { refresh: [fixture.submitted], imports: [queued] } };
}

export async function inertBackgroundMinute(host, fixture) {
  const startedAt = await vmTime(host), until = startedAt + 62000, observations = [];
  do {
    const fleets = [];
    for (const fleet of host.policy.fleets) {
      const observed = await nativeObservation(host, fleet.id, undefined, { captureProofs: true });
      assert.equal(observed.count, 0); assert.deepEqual(observed.keys, []); assert.equal(observed.truncated, false); fleets.push(observed);
    }
    const http = await backgroundHTTP(fixture.request, 404); observations.push({ at: await vmTime(host), fleets, http });
    if (await vmTime(host) >= until) break;
    await delay(10000);
  } while (true);
  return { startedAt, endedAt: await vmTime(host), observations };
}

export async function approveLifecycle(host, fixture) {
  const submitted = fixture.submitted;
  const missing = await expectRefusal(host, ['admin', 'approve', submitted.id, submitted.digest], /secret revision/);
  const revision = (await host.json(['admin', 'secrets', 'refresh'], { inputText: JSON.stringify({ REFRESH_TOKEN: fixture.secret }) })).revision;
  const wrong = await expectRefusal(host, ['admin', 'approve', submitted.id, submitted.digest, '00000000-0000-4000-8000-000000000000'], /secret revision/);
  for (const fleet of host.policy.fleets) assert.equal((await nativeObservation(host, fleet.id)).count, 0);
  assert.equal((await host.json(['admin', 'approve', submitted.id, submitted.digest, revision])).status, 'active');
  assert.equal((await host.json(['admin', 'dispatch', 'refresh', 'pause'])).observed, 'paused');
  assert.equal((await host.json(['admin', 'approve', fixture.queued.id, fixture.queued.digest])).status, 'active');
  assert.equal((await host.json(['admin', 'delivery', 'imports', 'pause'])).observed, 'paused');
  const state = await controllerState(host);
  fixture.approvals = Object.fromEntries(['refresh', 'imports'].map(name => [name, activeBackground(state, name)]));
  host.nativeBaseline = await nativeProcesses(host);
  return { missing, wrong, approvals: structuredClone(fixture.approvals) };
}

export function activeBackground(state, name) {
  const app = state.apps[name], request = state.deployments[app.active];
  assert.equal(request.app, name); assert.equal(request.status, 'active');
  return { app: name, id: request.id, digest: request.digest, slot: app.slot, version: request.version, secretRevision: request.secretRevision };
}

export async function controllerHeldMinute(host, fixture) {
  const armed = await armedTimer(host, fixture.approvals.refresh), deadline = armed.status.nextAlarm;
  const paused = await pauseFailureWork(host, fixture.approvals.refresh, () => vmTime(host));
  assert.ok(deadline > paused.confirmedAt, 'Pause must precede the observed natural deadline');
  assert.equal((await host.json(['admin', 'delivery', 'imports', 'pause'])).observed, 'paused');
  await importJob(fixture.request, 'held-input', 'kiwi\nlime');
  const before = await recoveredData(host, fixture.approvals), pending = rows(before.imports, 'import_jobs').find(row => row.id === 'held-input');
  assert.equal(pending.status, 'accepted'); assert.equal(pending.attempts, 0);
  assert.equal(before.imports.queuePeek.messages.length, 1); assert.equal(before.imports.queuePeek.messages[0].attempts, 0);
  await ownCompose(host, ['stop', 'controller']);
  const startedAt = await vmTime(host), http = [];
  const after = await heldDataInterval(host, { approvals: fixture.approvals, before: applicationData(before), until: Math.max(startedAt + 62000, deadline + 2000),
    beforeRead: async () => {
      const stopped = (await host.run('docker', ['inspect', '--format', '{{.State.Running}}', `${host.project}-controller-1`])).trim();
      assert.equal(stopped, 'false'); http.push({ at: await vmTime(host), ...await backgroundHTTP(fixture.request, 200) });
    },
    verify: async observed => { assert.equal(observed.refresh.status.paused, true); assert.equal(observed.refresh.status.nextAlarm, null); assert.equal(observed.imports.status.paused, true); assert.equal(observed.imports.status.backlogCount, 1); },
  });
  const endedAt = await vmTime(host); await ownCompose(host, ['start', 'controller']);
  await waitFor('background controller restart', async () => (await fixture.request('/v1/admin')).status === 200);
  const journals = {};
  for (const [name, surface] of [['refresh', 'dispatch'], ['imports', 'delivery']]) {
    const status = await host.json(['admin', surface, name, 'status']);
    assert.equal(status.desired, 'paused'); assert.equal(status.observed, 'paused'); journals[name] = status;
  }
  const restarted = await recoveredData(host, fixture.approvals);
  assert.deepEqual(applicationData(restarted), applicationData(before)); assert.deepEqual(await nativeProcesses(host), host.nativeBaseline);
  assert.ok(endedAt > deadline);
  return { armed, deadline, paused, before, after, restarted, startedAt, endedAt, http, journals };
}

export async function backgroundHTTP(request, expected) {
  const result = {};
  for (const [app, path] of [['refresh', '/api/refresh'], ['imports', '/api/imports']]) {
    const response = await request(path, { app }); assert.equal(response.status, expected);
    result[app] = { status: response.status, ...(expected === 200 ? { body: response.json() } : {}) };
  }
  return result;
}

export async function snapshotBackground(host, fixture) {
  await pauseFailureWork(host, fixture.approvals.refresh, () => vmTime(host));
  assert.equal((await host.json(['admin', 'delivery', 'imports', 'pause'])).observed, 'paused');
  const before = await recoveredData(host, fixture.approvals); assert.deepEqual(await nativeProcesses(host), host.nativeBaseline);
  const bundle = join(host.output, 'stopped-snapshot');
  await host.command(['backup', bundle, '--installation', host.project], { timeout: 300000 });
  const verified = await verifyDurableBundle(bundle, host.policy);
  for (const [name, active] of Object.entries(fixture.approvals)) {
    assert.equal(verified.state.apps[name].active, active.id); assert.equal(verified.state.deployments[active.id].digest, active.digest);
    const field = name === 'refresh' ? 'cron' : 'queue', preparation = verified.manifest[`${field}Recovery`].apps[name];
    assert.deepEqual(verified.state.apps[name][`${field}Snapshot`], preparation);
  }
  const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json')));
  assert.equal(manifest.cronRecovery.apps.refresh.observation.paused, true); assert.equal(manifest.cronRecovery.apps.refresh.observation.nextAlarm, null);
  assert.equal(manifest.queueRecovery.apps.imports.observation.paused, true);
  const shutdown = await stopSelectedHost(host, { alreadyStopped: true }); host.closed = true;
  return { before, bundle, manifest, shutdown };
}
