import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeFamily } from '../../packages/cli/src/runtime/catalog.mjs';
import { selectedHost, cleanupSelectedHost } from '../cron-probe/selected/host.mjs';
import { selectedHostOptions } from '../cron-probe/selected/options.mjs';
import { archiveSources, sourceInventory, sourceState, expectRefusal } from '../cron-probe/selected/evidence.mjs';
import { scanPublicSurfaces } from '../cron-probe/selected/privacy.mjs';
import { stopSelectedHost } from '../cron-probe/selected/shutdown.mjs';
import { captureFailureLogs } from '../cron-probe/selected/failure-logs.mjs';
import { controllerState } from '../cron-probe/selected/observations.mjs';
import { waitFor } from '../cron-probe/selected/https.mjs';
import { ownCompose } from '../capacity/serving-host.mjs';
import { diagnosticFixtures, diagnosticHandler, submitDiagnostic } from './diagnostics-fixture.mjs';
import { diagnostic, readyDiagnostic, checkDiagnostic, captureDiagnostic } from './diagnostics-checks.mjs';

const options = selectedHostOptions(process.argv.slice(2));
assert.equal(options.enrollment, 'candidate', 'Diagnostics qualification requires explicit candidate selection');
assert.equal(runtimeFamily(options.hostOptions.runtime, 'enrolled').routing, 'durable');
const provenance = await sourceState(), sources = await sourceInventory();
const host = await selectedHost(options.output, options.enrollment, undefined, options.hostOptions), evidence = {};
const save = (name, value) => writeFile(join(host.output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
let phase = 'fixtures', complete = false;
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  await archiveSources(host.output, provenance, sources, new URL(import.meta.url));
  const f = await diagnosticFixtures(host); evidence.approvals = f.approvals;
  phase = 'failing-and-healthy-handlers';
  evidence.failed = { native: await readyDiagnostic(host, f, 'baseline'), request: await checkDiagnostic(host, f, 'baseline', 500), logs: await captureDiagnostic(host, f, 'baseline', 'failed-logs') };
  evidence.peer = { native: await readyDiagnostic(host, f, 'peer'), request: await checkDiagnostic(host, f, 'peer', 200), logs: await captureDiagnostic(host, f, 'peer', 'peer-logs') };
  evidence.ordinaryCandidateRefusal = await expectRefusal(host, ['observe', 'baseline', '--installation', host.project], /requires an enrolled qualified/);
  phase = 'unavailable-replica';
  const fleet = host.policy.fleets.find(fleet => fleet.id === f.approvals.baseline.slot), node = fleet.nodes[0].host;
  await ownCompose(host, ['stop', node]);
  evidence.unavailable = { native: await diagnostic(host, f, 'observe', 'baseline'), logs: await captureDiagnostic(host, f, 'baseline', 'stopped-replica-logs') };
  assert.equal(evidence.unavailable.native.nativeReadiness, 'uncertain');
  await ownCompose(host, ['start', node]);
  evidence.restarted = { firstRead: await diagnostic(host, f, 'observe', 'baseline'), ready: await readyDiagnostic(host, f, 'baseline') };
  phase = 'paused-routing';
  const original = f.approvals.baseline;
  await host.command(['admin', 'routing', 'baseline', 'pause', original.id, original.digest]);
  evidence.paused = { request: await diagnostic(host, f, 'check', 'baseline', ['--path', '/api/diagnostic', '--ca', host.env.NODE_EXTRA_CA_CERTS]), logs: await captureDiagnostic(host, f, 'baseline', 'paused-logs') };
  assert.equal(evidence.paused.request.ingressResponse.state, 'not-requested');
  await host.command(['admin', 'routing', 'baseline', 'resume', original.id, original.digest]);
  phase = 'corrected-approval';
  await diagnosticHandler(f.projects.baseline, 'baseline', false);
  const corrected = await submitDiagnostic(host, f, 'baseline');
  await host.command(['admin', 'approve', corrected.id, corrected.digest, original.secretRevision]);
  const state = await controllerState(host); assert.equal(state.deployments[corrected.id].secretRevision, original.secretRevision);
  evidence.corrected = { approval: corrected, native: await readyDiagnostic(host, f, 'baseline'), request: await checkDiagnostic(host, f, 'baseline', 200), logs: await captureDiagnostic(host, f, 'baseline', 'corrected-logs') };
  phase = 'controller-loss'; await ownCompose(host, ['stop', 'controller']);
  evidence.controllerLoss = { native: await diagnostic(host, f, 'observe', 'baseline'), request: await checkDiagnostic(host, f, 'baseline', 200), peer: await checkDiagnostic(host, f, 'peer', 200), logs: await captureDiagnostic(host, f, 'baseline', 'controller-stopped-logs') };
  assert.equal(evidence.controllerLoss.native.nativeReadiness, 'uncertain');
  assert.equal(evidence.controllerLoss.native.controllerProcess, 'not-running');
  await ownCompose(host, ['start', 'controller']);
  await waitFor('diagnostic controller restart', async () => (await f.request('/v1/admin')).status === 200);
  evidence.finalRows = {};
  for (const app of ['baseline', 'peer']) {
    const response = await f.request('/api/write-probe', { app }); assert.equal(response.status, 200);
    evidence.finalRows[app] = response.json(); assert.deepEqual(evidence.finalRows[app], [{ id: `${app}-record`, app }]);
  }
  phase = 'privacy';
  evidence.privacy = await scanPublicSurfaces(host, f.request, f.submissions, f.tokens.builder, Object.values(f.secrets), evidence);
  phase = 'retained-shutdown'; evidence.shutdown = await stopSelectedHost(host); complete = true;
  assert.deepEqual(await sourceInventory(), sources); assert.deepEqual(await sourceState(), provenance);
  await save('result.json', { scope: 'Fresh selected durable-family Docker-owner diagnostics: failing/corrected handlers, private process-log capture with distinct private configuration, unavailable replicas, paused routing and controller-loss serving. Raw logs are deliberately unredacted private operator data. No developer log API, application-health inference or full runtime-family qualification.', family: host.entry.id, image: host.entry.image, sourcePolicy: host.policy, provenance, sources, project: host.project, evidence });
  // The captured streams and runtime.log intentionally contain app secrets. Only
  // diagnostic reports, artifacts, ordinary surfaces and this receipt are public-safe.
  console.log('PASS-native-diagnostics');
} catch (error) {
  if (!complete) evidence.failureLogs = await captureFailureLogs(host);
  await save('failure.json', { phase, name: error.name, message: error.message, evidence }); throw error;
} finally { clearInterval(heartbeat); if (!complete) await cleanupSelectedHost(host); }
