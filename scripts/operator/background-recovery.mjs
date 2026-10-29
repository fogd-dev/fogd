import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runtimeFamily } from '../../packages/cli/src/runtime/catalog.mjs';
import { composeResolved } from '../../packages/cli/src/recovery/bundle.mjs';
import { verifyDurableBundle } from '../../packages/cli/src/recovery/durable-bundle.mjs';
import { commandRunner } from '../cron-probe/selected/commands.mjs';
import { recoveryTarget } from '../cron-probe/selected/recovery-target.mjs';
import { coldRecovery, acknowledgeRecovery } from '../cron-probe/selected/recovery-holds.mjs';
import { applicationData } from '../cron-probe/selected/recovery-fixtures.mjs';
import { resumeCron, futurePhase, observeNoReplay } from '../cron-probe/selected/recovery-work.mjs';
import { setFaultPolicy } from '../cron-probe/selected/observations.mjs';
import { queuedInput, completeQueuedInput } from '../cron-probe/selected/retirement-steps.mjs';
import { httpsClient } from '../cron-probe/selected/https.mjs';
import { stopSelectedHost } from '../cron-probe/selected/shutdown.mjs';
import { cleanupSelectedHost } from '../cron-probe/selected/host.mjs';
import { sourceState, sourceInventory } from '../cron-probe/selected/evidence.mjs';
import { captureFailureLogs } from '../cron-probe/selected/failure-logs.mjs';
import { backgroundRecoverySource } from './background-source.mjs';

if (process.argv.length !== 4) throw new Error('Usage: node scripts/operator/background-recovery.mjs ACCEPTED_LIFECYCLE_OUTPUT NEW_PRIVATE_OUTPUT');
const output = resolve(process.argv[3]);
const repo = fileURLToPath(new URL('../../', import.meta.url)), read = async file => JSON.parse(await readFile(file));
const { acceptedRoot, original, sourceRoot, inputs, bundle, approvals } = await backgroundRecoverySource(process.argv[2]);
const entry = runtimeFamily(original.family, 'enrolled'); assert.equal(entry.routing, 'durable');
assert.equal(entry.image, original.image); assert.equal(inputs.retainResources, true);
const config = composeResolved(await read(join(sourceRoot, 'host/.fogd/installations', inputs.project, 'compose.json')));
const env = { ...process.env, ...parseEnv(await readFile(join(sourceRoot, 'operator.env'), 'utf8')),
  FOGD_HOME: join(sourceRoot, 'host'), FOGD_ENV_FILE: join(sourceRoot, 'operator.env'), FOGD_COMPOSE_FILE: join(repo, 'compose.yaml'),
  COMPOSE_PROJECT_NAME: inputs.project, NODE_EXTRA_CA_CERTS: join(sourceRoot, 'certificate.pem'), FOGD_SERVER: `https://localhost:${inputs.adminPort}`,
  FOGD_ADMIN_PORT: String(inputs.adminPort), FOGD_HTTP_PORT: String(inputs.gatewayPort), FOGD_TLS: '1', FOGD_PROFILE: 'shared', FOGD_QUEUE_APPS: '1' };
const source = { output: sourceRoot, project: inputs.project, env, config, entry, policy: original.sourcePolicy, adminPort: inputs.adminPort, gatewayPort: inputs.gatewayPort, retainResources: true };
source.run = commandRunner(sourceRoot, env);
const checked = await verifyDurableBundle(bundle, source.policy);
const point = { before: applicationData(original.evidence.snapshot.before), sourceObservation: original.evidence.snapshot.before, approvals, manifest: checked.manifest };
await mkdir(output, { mode: 0o700 });
const provenance = await sourceState(), sources = await sourceInventory(), evidence = {};
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await save('executed-source-inventory.json', { provenance, sources });
for (const path of Object.keys(sources)) { const target = join(output, 'executed-source', path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await cp(join(repo, path), target); }
await save('inputs.json', { acceptedRoot, sourceRoot, sourceProject: source.project, family: entry.id, image: entry.image, snapshot: createHash('sha256').update(await readFile(join(bundle, 'manifest.json'))).digest('hex') });
let target, phase = 'restore', complete = false;
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  target = await recoveryTarget(source, bundle, join(output, 'target'), [source], checked.manifest.images);
  phase = 'cold-native-hold'; evidence.cold = await coldRecovery(target, point, [source, target]);
  phase = 'verified-acknowledgment'; const request = await httpsClient(target);
  evidence.acknowledged = await acknowledgeRecovery(target, point, [source, target], request);
  phase = 'explicit-queue-resume';
  const pending = await queuedInput(target, request, approvals.imports, 'after-restore', 'papaya\nfig', ['PAPAYA', 'FIG']);
  evidence.queue = { pending, completed: await completeQueuedInput(target, approvals.imports, pending) };
  phase = 'explicit-cron-resume';
  await setFaultPolicy(target, approvals.refresh.slot, approvals.refresh.id, 'healthy', 'after-a');
  const resumed = await resumeCron(target, approvals.refresh);
  evidence.cron = { resumed, future: await futurePhase(target, approvals.refresh, 'after-a', resumed.requestedAt, 260000) };
  phase = 'no-old-occurrence-replay'; evidence.noReplay = await observeNoReplay(target, approvals.refresh, point, resumed.requestedAt, 'after-a');
  phase = 'retained-shutdown'; evidence.shutdown = await stopSelectedHost(target); complete = true;
  assert.deepEqual(await sourceInventory(), sources); assert.deepEqual(await sourceState(), provenance);
  await save('result.json', { scope: 'Same-family durable restore of a paused cron/queue snapshot onto fresh volumes: cold native holds, verified explicit recovery acknowledgment, HTTP availability with background work still paused, explicit live resume and retained rows. No due snapshot, pending retry snapshot, older snapshot, power-loss or full recovery-family acceptance.', provenance, sources, family: entry.id, image: entry.image, sourceProject: source.project, project: target.project, initialServices: target.initialServices, evidence });
  console.log('PASS-durable-background-recovery');
} catch (error) {
  if (target && !complete) evidence.failureLogs = await captureFailureLogs(target);
  await save('failure.json', { phase, name: error.name, message: error.message, evidence }); throw error;
} finally { clearInterval(heartbeat); if (target && !complete) await cleanupSelectedHost(target); }
