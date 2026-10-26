import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { httpsClient, scopedClient, waitFor } from '../cron-probe/selected/https.mjs';
import { ownCompose } from './serving-host.mjs';
import { writeFixture } from './write-fixture.mjs';
import { reconcileWrites } from './write-ledger.mjs';
import { paddedUpload } from './padded-upload.mjs';

export async function writeFixtures(host) {
  const request = await httpsClient(host); await waitFor('write measurement owner API', async () => (await request('/v1/admin')).status === 200);
  const token = (await host.json(['admin', 'issue-token', 'write-builder', 'baseline,peer'])).token, submissions = [];
  for (const app of ['baseline', 'peer']) {
    const project = await writeFixture(host, app), submitted = await host.json(['deploy', '--name', app], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: project });
    assert.equal(submitted.status, 'pending'); submissions.push(submitted);
    if (app === 'baseline') await host.command(['admin', 'approve', submitted.id, submitted.digest]);
  }
  const state = (await request('/v1/admin')).json(), fleet = host.policy.fleets.find(f => f.id === state.apps.baseline.slot); assert.ok(fleet);
  const control = await writeErrorControl(request, 'baseline');
  const artifact = await request(`/v1/deployments/${submissions[1].id}/artifact`); assert.equal(artifact.status, 200);
  const upload = paddedUpload(artifact.json()); assert.ok(state.quota.maxArtifactBytes - state.quota.retainedArtifactBytes >= upload.artifactBytes * 2);
  return { request, scoped: await scopedClient(host, token), tokens: { builder: token }, secret: token, submissions, fleet, upload,
    baseline: { id: submissions[0].id, digest: submissions[0].digest }, initialRetainedBytes: state.quota.retainedArtifactBytes, control };
}
export async function writeErrorControl(request, app) {
  const response = await request('/api/write-probe', { app, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'post-commit-error-control' }) });
  assert.equal(response.status, 502);
  const attempt = { writeId: 'post-commit-error-control', status: response.status, correct: false };
  const recorded = await request('/api/write-probe', { app }); assert.equal(recorded.status, 200);
  const reconciliation = reconcileWrites([attempt], recorded.json(), app); assert.deepEqual(reconciliation.unacknowledgedCommitted, [{ writeId: attempt.writeId, status: 502 }]);
  return { attempt, reconciliation };
}
export function writePhases(host, f) {
  return [
    ['one-app', 10000, null],
    ['peer-approval', 45000, async () => { const peer = f.submissions[1], approved = await host.json(['admin', 'approve', peer.id, peer.digest]); assert.equal(approved.status, 'active'); return { peerApproved: true, activeDigest: approved.digest }; }],
    ...approvedWritePhases(host, f),
  ];
}
export function approvedWritePhases(host, f) {
  return [
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
export async function recordWriteLedger(f, attempts, report, app = 'baseline') {
  const began = performance.now(); report.ledgerRead = { startedAt: new Date().toISOString(), readCount: 1, status: null };
  let response;
  try { response = await f.request('/api/write-probe', { app }); }
  finally { report.ledgerRead.elapsedMs = performance.now() - began; }
  report.ledgerRead.status = response.status;
  assert.equal(response.status, 200); report.ledgerRows = response.json();
  report.cumulativeReconciliation = reconcileWrites(attempts, report.ledgerRows, app);
  const phaseIds = new Set(report.samples.map(sample => sample.writeId));
  report.phaseReconciliation = reconcileWrites(report.samples, report.ledgerRows.filter(row => phaseIds.has(row.id)), app);
  assert.deepEqual(report.cumulativeReconciliation.acknowledgedMissing, [], 'An acknowledged write is absent from the first recorded ledger read');
}
