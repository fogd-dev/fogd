import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFamily } from '../../../packages/cli/src/runtime/catalog.mjs';
import { composeResolved, verifyBundle } from '../../../packages/cli/src/recovery/bundle.mjs';
import { readPolicyVolume } from '../../../packages/cli/src/runtime/policy-volume.mjs';
import { commandRunner } from './commands.mjs';
import { recoveryTarget } from './recovery-target.mjs';
import { coldRecovery, acknowledgeRecovery } from './recovery-holds.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { cleanupSelectedHost } from './host.mjs';

if (process.argv.length !== 4) throw new Error('Usage: node scripts/cron-probe/selected/recovery-cold-smoke.mjs SOURCE_SMOKE_OUTPUT NEW_OUTPUT');
const sourceRoot = resolve(process.argv[2]), output = resolve(process.argv[3]), repo = fileURLToPath(new URL('../../../', import.meta.url));
const original = JSON.parse(await readFile(join(sourceRoot, 'result.json'))), inputs = JSON.parse(await readFile(join(sourceRoot, 'inputs.json')));
const config = composeResolved(JSON.parse(await readFile(join(sourceRoot, 'host/.fogd/installations', original.project, 'compose.json'))));
const entry = runtimeFamily(original.policy.family, 'enrolled'), env = { ...process.env, ...parseEnv(await readFile(join(sourceRoot, 'operator.env'), 'utf8')),
  FOGD_HOME: join(sourceRoot, 'host'), FOGD_ENV_FILE: join(sourceRoot, 'operator.env'), FOGD_COMPOSE_FILE: join(repo, 'compose.yaml'),
  COMPOSE_PROJECT_NAME: original.project, NODE_EXTRA_CA_CERTS: join(sourceRoot, 'certificate.pem'), FOGD_SERVER: `https://localhost:${inputs.adminPort}`,
  FOGD_ADMIN_PORT: String(inputs.adminPort), FOGD_HTTP_PORT: String(inputs.gatewayPort), FOGD_TLS: '1', FOGD_PROFILE: 'shared', FOGD_QUEUE_APPS: '1' };
const source = { output: sourceRoot, project: original.project, env, config, entry, policy: original.policy, adminPort: inputs.adminPort, gatewayPort: inputs.gatewayPort };
source.run = commandRunner(sourceRoot, env);
assert.deepEqual(await readPolicyVolume(entry.image, config.volumes['runtime-policy'].name, config.services.controller.environment), source.policy);
const bundle = join(sourceRoot, 'snapshot-a'), verified = await verifyBundle(bundle);
assert.equal(verified.manifest.queueRecovery.apps.imports.observation.backlogCount, 0);
const point = { before: original.before, approvals: original.approvals, prepared: original.prepared, manifest: verified.manifest, queueMessages: [] };
let target, phase = 'restore', completed = false;
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  target = await recoveryTarget(source, bundle, output, [source], verified.manifest.images);
  phase = 'cold-native-hold'; const cold = await coldRecovery(target, point, [source, target]);
  phase = 'normal-startup-and-acknowledged-hold'; const acknowledged = await acknowledgeRecovery(target, point, [source, target]);
  phase = 'clean-shutdown'; const shutdown = await stopSelectedHost(target); completed = true;
  await writeFile(join(output, 'result.json'), JSON.stringify({ scope: 'Selected cold restore and explicit acknowledgment smoke; no pending-retry/older acceptance', project: target.project, sourceProject: source.project, initialServices: target.initialServices, cold, acknowledged, shutdown }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('PASS-selected-cold-recovery-smoke');
} catch (error) {
  if (target) await writeFile(join(output, 'failure.json'), JSON.stringify({ phase, name: error.name, message: error.message }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  throw error;
} finally { clearInterval(heartbeat); if (target && !completed) await cleanupSelectedHost(target); }
