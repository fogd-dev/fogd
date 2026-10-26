import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { selectedHostTrial } from '../cron-probe/selected/selected-trial.mjs';
import { scanPublicSurfaces } from '../cron-probe/selected/privacy.mjs';
import { stopSelectedHost } from '../cron-probe/selected/shutdown.mjs';
import { observeWindow, startObserver, hardware, stackMetrics } from '../capacity/serving-host.mjs';
import { writeFixtures, writePhases, recordWriteLedger } from '../capacity/write-workload.mjs';
import { writeServingOptions } from '../capacity/serving-options.mjs';

const options = writeServingOptions(process.argv.slice(2));
await selectedHostTrial(options.output, 'Paced D1 writes on the explicitly selected local two-fleet family: one approved app versus an idle approved peer, concurrent maximum peer uploads, peer approval, controller interruption, response/ledger reconciliation and an explicit post-commit error control. No mutation replay, density limit, cross-host or power-loss durability claim.', async context => {
  const { source: host, evidence } = context, f = await writeFixtures(host), observer = `${host.project}-observer`;
  evidence.hardware = await hardware(host); evidence.routing = host.policy.routing ?? 'legacy'; evidence.phases = {}; evidence.postCommitErrorControl = f.control;
  evidence.submissions = f.submissions; evidence.baseline = f.baseline;
  await startObserver(host, observer, f.fleet);
  const settings = { targets: { gateway: 'workerd', direct: f.fleet.nodes[0].host }, ca: await readFile(host.env.NODE_EXTRA_CA_CERTS, 'utf8'), concurrency: 2, maxDurationMs: 300000 };
  const read = await f.request('/api/messages', { app: 'baseline' }); assert.equal(read.status, 200);
  evidence.readControl = await observeWindow(host, observer, 'read-control', { ...settings, durationMs: 3000, bodySha256: createHash('sha256').update(read.text).digest('hex') });
  assert.equal(evidence.readControl.summaries.gateway.errors, 0); assert.equal(evidence.readControl.summaries.direct.errors, 0);
  const attempts = [f.control.attempt];
  for (const [name, durationMs, action] of writePhases(host, f)) {
    context.phase = name;
    const report = await observeWindow(host, observer, name, { ...settings, workload: 'writes', phase: name, durationMs }, action);
    evidence.phases[name] = report; attempts.push(...report.samples);
    await recordWriteLedger(f, attempts, report);
    const state = (await f.request('/v1/admin')).json();
    report.approvedApps = Object.keys(state.apps).length; report.components = await stackMetrics(host);
    report.routing = Object.fromEntries(Object.entries(state.apps).map(([app, value]) => [app, { slot: value.slot, active: value.active }]));
    assert.equal(report.approvedApps, name === 'one-app' ? 1 : 2);
    assert.equal(state.apps.baseline.active, f.baseline.id); assert.equal(state.deployments[f.baseline.id].digest, f.baseline.digest);
    const peerRows = await f.request('/api/write-probe', { app: 'peer' });
    if (name === 'one-app') assert.equal(peerRows.status, 404); else { assert.notEqual(state.apps.baseline.slot, state.apps.peer.slot); assert.equal(peerRows.status, 200); assert.deepEqual(peerRows.json(), []); }
    if (['one-app', 'two-apps', 'recovered'].includes(name)) { assert.equal(report.summaries.direct.errors, 0); assert.equal(report.summaries.gateway.errors, 0); }
    if (name === 'controller-outage') {
      assert.equal(report.summaries.direct.errors, 0);
      if (host.policy.routing === 'durable') assert.equal(report.summaries.gateway.errors, 0);
      else assert.ok(report.interference.overlappingRequests.gateway.statuses[503] > 0);
    }
  }
  evidence.privacy = await scanPublicSurfaces(host, (path, options = {}) => f.request(path, { ...options, maxResponseBytes: path.endsWith('/artifact') ? 64 * 1024 ** 2 : 4 * 1024 ** 2 }), f.submissions, f.tokens.builder, [], evidence);
  context.phase = 'clean-shutdown'; evidence.shutdown = await stopSelectedHost(host); host.closed = true;
  return f;
}, options.enrollment, options.hostOptions);
