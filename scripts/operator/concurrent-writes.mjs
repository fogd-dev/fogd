import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { selectedHostTrial } from '../cron-probe/selected/selected-trial.mjs';
import { scanPublicSurfaces } from '../cron-probe/selected/privacy.mjs';
import { stopSelectedHost } from '../cron-probe/selected/shutdown.mjs';
import { observeWindows, startObserver, hardware, stackMetrics } from '../capacity/serving-host.mjs';
import { writeFixtures, approvedWritePhases, writeErrorControl, recordWriteLedger } from '../capacity/write-workload.mjs';
import { writeServingOptions } from '../capacity/serving-options.mjs';
import { writeOverlap } from '../capacity/write-overlap.mjs';

const options = writeServingOptions(process.argv.slice(2));
await selectedHostTrial(options.output, 'Two approved applications writing concurrently through gateway and direct replica paths, including peer uploads, peer activation and controller interruption. Per-app first-read ledgers and intentionally shared operation IDs check application isolation. No mutation replay, saturation, density, separate-machine or power-loss qualification.', async context => {
  const { source: host, evidence } = context, f = await writeFixtures(host), peer = f.submissions[1];
  assert.equal((await host.json(['admin', 'approve', peer.id, peer.digest])).status, 'active');
  evidence.controls = { baseline: f.control, peer: await writeErrorControl(f.request, 'peer') };
  evidence.hardware = await hardware(host); evidence.routing = host.policy.routing ?? 'legacy'; evidence.phases = {};
  evidence.submissions = f.submissions; evidence.baseline = f.baseline;
  const state = (await f.request('/v1/admin')).json(), observers = [];
  assert.notEqual(state.apps.baseline.slot, state.apps.peer.slot);
  for (const app of ['baseline', 'peer']) {
    const fleet = host.policy.fleets.find(value => value.id === state.apps[app].slot), observer = `${host.project}-${app}-observer`;
    await startObserver(host, observer, fleet);
    observers.push({ app, observer, settings: { app, targets: { gateway: 'workerd', direct: fleet.nodes[0].host }, ca: await readFile(host.env.NODE_EXTRA_CA_CERTS, 'utf8'), concurrency: 2, maxDurationMs: 300000 } });
  }
  evidence.hardware.observer.count = observers.length;
  const readSettings = await Promise.all(observers.map(async value => {
    const response = await f.request('/api/messages', { app: value.app }); assert.equal(response.status, 200);
    return { ...value, settings: { ...value.settings, durationMs: 3000, bodySha256: createHash('sha256').update(response.text).digest('hex') } };
  }));
  const reads = await observeWindows(host, readSettings, 'read-control');
  evidence.readControls = Object.fromEntries(observers.map(({ app }, index) => [app, reads[index]]));
  for (const read of reads) for (const path of ['gateway', 'direct']) assert.equal(read.summaries[path].errors, 0);
  const attempts = Object.fromEntries(observers.map(({ app }) => [app, [evidence.controls[app].attempt]]));
  for (const [name, durationMs, action] of approvedWritePhases(host, f)) {
    context.phase = name;
    const reports = await observeWindows(host, observers.map(value => ({ ...value, settings: { ...value.settings, workload: 'writes', phase: name, durationMs } })), name, action);
    const phase = { apps: Object.fromEntries(observers.map(({ app }, index) => [app, reports[index]])), overlap: writeOverlap(reports) };
    evidence.phases[name] = phase;
    assert.ok(phase.overlap.overlapMs >= durationMs - 2000); assert.ok(phase.overlap.sharedOperationIds > 0);
    await Promise.all(observers.map(async ({ app }, index) => {
      attempts[app].push(...reports[index].samples); await recordWriteLedger(f, attempts[app], reports[index], app);
      if (['two-apps', 'recovered'].includes(name) || (name === 'controller-outage' && host.policy.routing === 'durable')) {
        for (const path of ['gateway', 'direct']) assert.equal(reports[index].summaries[path].errors, 0);
      }
      if (name === 'controller-outage') {
        assert.equal(reports[index].summaries.direct.errors, 0);
        if (host.policy.routing !== 'durable') assert.ok(reports[index].interference.overlappingRequests.gateway.statuses[503] > 0);
      }
    }));
    const current = (await f.request('/v1/admin')).json(); phase.components = await stackMetrics(host);
    phase.routing = Object.fromEntries(Object.entries(current.apps).map(([app, value]) => [app, { slot: value.slot, active: value.active }]));
    assert.equal(Object.keys(current.apps).length, 2); assert.equal(current.apps.baseline.active, f.baseline.id);
    assert.equal(current.deployments[f.baseline.id].digest, f.baseline.digest);
    assert.equal(current.apps.peer.active, ['activation', 'controller-outage', 'recovered'].includes(name) ? f.submissions[2].id : peer.id);
    for (const app of ['baseline', 'peer']) assert.equal(current.apps[app].slot, state.apps[app].slot);
  }
  evidence.privacy = await scanPublicSurfaces(host, (path, settings = {}) => f.request(path, { ...settings, maxResponseBytes: path.endsWith('/artifact') ? 64 * 1024 ** 2 : 4 * 1024 ** 2 }), f.submissions, f.tokens.builder, [], evidence);
  context.phase = 'clean-shutdown'; evidence.shutdown = await stopSelectedHost(host); host.closed = true;
  return f;
}, options.enrollment, options.hostOptions);
