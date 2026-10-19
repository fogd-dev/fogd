// Real Docker regressions for admission-off retries and inert history/name reuse.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configEnv, stackRoot, run } from '../packages/cli/src/local.mjs';
import { resolvedCompose } from '../packages/cli/src/compose/config.mjs';
import { composeArgs, json } from '../packages/cli/src/recovery/docker.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { backup } from '../packages/cli/src/recovery/backup.mjs';
import { expect } from './guestbook-browser.mjs';
const output = resolve(process.argv[2]); await mkdir(output, { mode: 0o700 });
const env = await configEnv(), config = await resolvedCompose(env), file = env.FOGD_COMPOSE_FILE;
assert.match(config.name, /^fogd-m11[a-z0-9-]*$/);
const [image] = await json(['image', 'inspect', 'fogd-runtime:local']);
const prior = config.services.controller.image;
for (const service of Object.values(config.services)) if (service.image === prior) service.image = image.Id;
config.services.controller.environment.FOGD_QUEUE_APPS = '1';
await writeFile(file, JSON.stringify(config, null, 2) + '\n');
const compose = args => execute('docker', [...composeArgs(file, config.name), ...args]);
const cli = args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env });
const auth = { Authorization: `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
async function admin() { const r = await fetch(`http://127.0.0.1:${env.FOGD_ADMIN_PORT}/v1/admin`, { headers: auth }); assert.equal(r.status, 200); return r.json(); }
await compose(['up', '-d', '--pull', 'never']);
await expect.poll(async () => { try { return (await admin()).apps['imports-public'].route; } catch { return null; } }, { timeout: 120000 }).toBe('active');
const credential = JSON.parse(await cli(['admin', 'issue-token', 'queue-history-qualification', 'imports-claim,imports-public']));
async function deploy(project, app) {
  const before = new Set(Object.keys((await admin()).deployments));
  const log = await run(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), 'deploy', '--name', app], { cwd: join(stackRoot, 'examples', project), env: { ...env, FOGD_DEPLOY_TOKEN: credential.token }, capture: true });
  const added = Object.values((await admin()).deployments).filter(r => !before.has(r.id)); assert.equal(added.length, 1);
  await writeFile(join(output, `${added[0].id}.log`), log, { mode: 0o600 }); return added[0];
}
const pending = await deploy('imports', 'imports-claim'), rejected = await deploy('imports', 'imports-claim');
await cli(['admin', 'reject', rejected.id, rejected.digest]);
const ordinary = await deploy('hello', 'imports-claim');
await cli(['admin', 'approve', ordinary.id, ordinary.digest]);
let state = await admin();
assert.equal(state.deployments[pending.id].status, 'superseded');
assert.equal(state.deployments[rejected.id].status, 'rejected');
assert.ok(Object.values(state.deployments).some(r => r.app === 'imports-claim' && r.claimRelease));
const retry = await deploy('imports', 'imports-public');
const slot = JSON.parse(config.services.controller.environment.FOGD_SLOTS).find(s => s.id === state.apps['imports-public'].slot);
const node = `${slot.id}-a`;
await compose(['stop', node]);
let approval;
try {
  approval = cli(['admin', 'approve', retry.id, retry.digest]).then(() => ({ succeeded: true }), () => ({ interrupted: true }));
  await expect.poll(async () => (await admin()).apps['imports-public'].delivery.hold, { timeout: 120000 }).toBe(retry.id);
  await compose(['kill', '-s', 'SIGKILL', 'controller']);
  assert.equal((await approval).interrupted, true);
  config.services.controller.environment.FOGD_QUEUE_APPS = '0';
  await writeFile(file, JSON.stringify(config, null, 2) + '\n');
} finally { await compose(['up', '-d', '--pull', 'never', node, 'controller']); }
await expect.poll(async () => { try { return (await admin()).deployments[retry.id].status; } catch { return null; } }, { timeout: 120000 }).toBe('failed');
await cli(['admin', 'approve', retry.id, retry.digest]);
state = await admin(); assert.equal(state.deployments[retry.id].status, 'active');
assert.equal(state.apps['imports-public'].delivery.hold, null);
assert.equal(state.apps['imports-public'].delivery.desired, 'paused');
const manifest = await backup(join(output, 'snapshot'));
assert.deepEqual(Object.keys(manifest.queueRecovery.apps), ['imports-public']);
await writeFile(join(output, 'history.json'), JSON.stringify({ image: image.Id, project: config.name, admissionSetting: '0', supersededUnapproved: pending.id, rejectedUnapproved: rejected.id, nonQueueApproval: ordinary.id, retriedPinnedApproval: retry.id, approvedRetryWithAdmissionOff: true, backupAfterNameReuse: true, preparedApps: Object.keys(manifest.queueRecovery.apps), exits: manifest.exits }, null, 2) + '\n', { mode: 0o600 });
console.log('PASS: current image retries a pinned queue approval with admission off and backs up inert history after name reuse');
