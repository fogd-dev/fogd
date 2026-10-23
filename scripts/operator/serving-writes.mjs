import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { selectedHostTrial } from '../cron-probe/selected/selected-trial.mjs';
import { httpsClient, scopedClient, waitFor } from '../cron-probe/selected/https.mjs';
import { scanPublicSurfaces } from '../cron-probe/selected/privacy.mjs';
import { stopSelectedHost } from '../cron-probe/selected/shutdown.mjs';
import { observeWindow, startObserver, ownCompose, hardware, stackMetrics } from '../capacity/serving-host.mjs';
import { writeFixture } from '../capacity/write-fixture.mjs';
import { reconcileWrites } from '../capacity/write-ledger.mjs';
import { paddedUpload } from '../capacity/padded-upload.mjs';

await selectedHostTrial(process.argv[2], 'Paced D1 writes on the frozen local two-fleet family: one approved app versus an idle approved peer, concurrent maximum peer uploads, peer approval, controller interruption, response/ledger reconciliation and an explicit post-commit error control. No mutation replay, density limit, cross-host or power-loss durability claim.', async context => {
  const { source: host, evidence } = context, f = await fixtures(host), observer = `${host.project}-observer`;
  evidence.hardware = await hardware(host); evidence.phases = {}; evidence.postCommitErrorControl = f.control;
  evidence.submissions = f.submissions; evidence.baseline = f.baseline;
  await startObserver(host, observer, f.fleet);
  const settings = { targets: { gateway: 'workerd', direct: f.fleet.nodes[0].host }, ca: await readFile(host.env.NODE_EXTRA_CA_CERTS, 'utf8'), concurrency: 2, maxDurationMs: 300000 };
  const read = await f.request('/api/messages', { app: 'baseline' }); assert.equal(read.status, 200);
  evidence.readControl = await observeWindow(host, observer, 'read-control', { ...settings, durationMs: 3000, bodySha256: createHash('sha256').update(read.text).digest('hex') });
  assert.equal(evidence.readControl.summaries.gateway.errors, 0); assert.equal(evidence.readControl.summaries.direct.errors, 0);
  const attempts = [f.control.attempt];
  for (const [name, durationMs, action] of phases(host, f)) {
    context.phase = name;
    const report = await observeWindow(host, observer, name, { ...settings, workload: 'writes', phase: name, durationMs }, action);
    evidence.phases[name] = report; attempts.push(...report.samples);
    await recordLedger(f, attempts, report);
    const state = (await f.request('/v1/admin')).json();
    report.approvedApps = Object.keys(state.apps).length; report.components = await stackMetrics(host);
    report.routing = Object.fromEntries(Object.entries(state.apps).map(([app, value]) => [app, { slot: value.slot, active: value.active }]));
    assert.equal(report.approvedApps, name === 'one-app' ? 1 : 2);
    assert.equal(state.apps.baseline.active, f.baseline.id); assert.equal(state.deployments[f.baseline.id].digest, f.baseline.digest);
    const peerRows = await f.request('/api/write-probe', { app: 'peer' });
    if (name === 'one-app') assert.equal(peerRows.status, 404); else { assert.notEqual(state.apps.baseline.slot, state.apps.peer.slot); assert.equal(peerRows.status, 200); assert.deepEqual(peerRows.json(), []); }
    if (['one-app', 'two-apps', 'recovered'].includes(name)) { assert.equal(report.summaries.direct.errors, 0); assert.equal(report.summaries.gateway.errors, 0); }
    if (name === 'controller-outage') assert.ok(report.interference.overlappingRequests.gateway.statuses[503] > 0);
  }
  evidence.privacy = await scanPublicSurfaces(host, (path, options = {}) => f.request(path, { ...options, maxResponseBytes: path.endsWith('/artifact') ? 64 * 1024 ** 2 : 4 * 1024 ** 2 }), f.submissions, f.tokens.builder, [], evidence);
  context.phase = 'clean-shutdown'; evidence.shutdown = await stopSelectedHost(host); host.closed = true;
  return f;
}, 'public');

async function fixtures(host) {
  const request = await httpsClient(host); await waitFor('write measurement owner API', async () => (await request('/v1/admin')).status === 200);
  const token = (await host.json(['admin', 'issue-token', 'write-builder', 'baseline,peer'])).token, submissions = [];
  for (const app of ['baseline', 'peer']) {
    const project = await writeFixture(host, app), submitted = await host.json(['deploy', '--name', app], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: project });
    assert.equal(submitted.status, 'pending'); submissions.push(submitted);
    if (app === 'baseline') await host.command(['admin', 'approve', submitted.id, submitted.digest]);
  }
  const state = (await request('/v1/admin')).json(), fleet = host.policy.fleets.find(f => f.id === state.apps.baseline.slot); assert.ok(fleet);
  const response = await request('/api/write-probe', { app: 'baseline', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'post-commit-error-control' }) });
  assert.equal(response.status, 502);
  const attempt = { writeId: 'post-commit-error-control', status: response.status, correct: false };
  const recorded = await request('/api/write-probe', { app: 'baseline' }); assert.equal(recorded.status, 200);
  const control = reconcileWrites([attempt], recorded.json()); assert.deepEqual(control.unacknowledgedCommitted, [{ writeId: attempt.writeId, status: 502 }]);
  const artifact = await request(`/v1/deployments/${submissions[1].id}/artifact`); assert.equal(artifact.status, 200);
  const upload = paddedUpload(artifact.json()); assert.ok(state.quota.maxArtifactBytes - state.quota.retainedArtifactBytes >= upload.artifactBytes * 2);
  return { request, scoped: await scopedClient(host, token), tokens: { builder: token }, secret: token, submissions, fleet, upload,
    baseline: { id: submissions[0].id, digest: submissions[0].digest }, initialRetainedBytes: state.quota.retainedArtifactBytes, control: { attempt, reconciliation: control } };
}
function phases(host, f) {
  return [
    ['one-app', 10000, null],
    ['peer-approval', 45000, async () => { const peer = f.submissions[1], approved = await host.json(['admin', 'approve', peer.id, peer.digest]); assert.equal(approved.status, 'active'); return { peerApproved: true, activeDigest: approved.digest }; }],
    ['two-apps', 10000, null],
    ['uploads', 20000, async () => {
      const responses = await Promise.all([1, 2].map(() => f.scoped('/v1/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: f.upload.payload, timeoutMs: 120000 })));
      for (const response of responses) { assert.equal(response.status, 201); const submitted = response.json(); assert.equal(submitted.status, 'pending'); assert.equal(submitted.digest, f.upload.digest); f.submissions.push(submitted); }
      const state = (await f.request('/v1/admin')).json(); assert.equal(state.quota.retainedArtifactBytes, f.initialRetainedBytes + f.upload.artifactBytes * 2);
      return { simultaneousUploads: 2, artifactBytesEach: f.upload.artifactBytes, pendingOnly: true };
    }],
    ['activation', 45000, async () => { const peer = f.submissions[2], approved = await host.json(['admin', 'approve', peer.id, peer.digest]); assert.equal(approved.status, 'active'); return { app: 'peer', activeDigest: approved.digest }; }],
    ['controller-outage', 30000, async () => {
      await ownCompose(host, ['stop', 'controller']); await delay(3000); await ownCompose(host, ['start', 'controller']);
      await waitFor('write controller restart', async () => (await f.request('/v1/admin')).status === 200);
      await waitFor('write gateway recovery', async () => (await f.request('/api/write-probe', { app: 'baseline' })).status === 200);
      return { controllerStoppedAndStarted: true, intentionalStoppedDelayMs: 3000 };
    }],
    ['recovered', 10000, null],
  ];
}
async function recordLedger(f, attempts, report) {
  const began = performance.now(); report.ledgerRead = { startedAt: new Date().toISOString(), readCount: 1, status: null };
  let response;
  try { response = await f.request('/api/write-probe', { app: 'baseline' }); }
  finally { report.ledgerRead.elapsedMs = performance.now() - began; }
  report.ledgerRead.status = response.status;
  assert.equal(response.status, 200); report.ledgerRows = response.json();
  report.cumulativeReconciliation = reconcileWrites(attempts, report.ledgerRows);
  const phaseIds = new Set(report.samples.map(sample => sample.writeId));
  report.phaseReconciliation = reconcileWrites(report.samples, report.ledgerRows.filter(row => phaseIds.has(row.id)));
  assert.deepEqual(report.cumulativeReconciliation.acknowledgedMissing, [], 'An acknowledged write is absent from the first recorded ledger read');
}
