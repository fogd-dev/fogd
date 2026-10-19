// Exercise a genuine first-claim failure through the normal approval API.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configEnv, stackRoot, run } from '../packages/cli/src/local.mjs';
import { resolvedCompose } from '../packages/cli/src/compose/config.mjs';
import { composeArgs } from '../packages/cli/src/recovery/docker.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { backup } from '../packages/cli/src/recovery/backup.mjs';
import { expect } from './guestbook-browser.mjs';
const output = resolve(process.argv[2]); await mkdir(output, { mode: 0o700 });
const env = await configEnv(), config = await resolvedCompose(env), file = env.FOGD_COMPOSE_FILE;
assert.match(config.name, /^fogd-m11[a-z0-9-]*$/);
const compose = args => execute('docker', [...composeArgs(file, config.name), ...args]);
const cli = args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env });
const auth = { Authorization: `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
async function admin() { const r = await fetch(`http://127.0.0.1:${env.FOGD_ADMIN_PORT}/v1/admin`, { headers: auth }); assert.equal(r.status, 200); return r.json(); }
const app = 'imports-claim';
assert.equal((await admin()).apps[app], undefined);
const credential = JSON.parse(await cli(['admin', 'issue-token', 'queue-claim-qualification', app]));
const built = await run(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), 'deploy', '--name', app], { cwd: join(stackRoot, 'examples/imports'), env: { ...env, FOGD_DEPLOY_TOKEN: credential.token }, capture: true });
await writeFile(join(output, 'deploy.log'), built, { mode: 0o600 });
const matches = Object.values((await admin()).deployments).filter(r => r.app === app); assert.equal(matches.length, 1);
const deployment = matches[0];
try {
  await compose(['stop', 'minio']);
  await assert.rejects(cli(['admin', 'approve', deployment.id, deployment.digest]));
} finally { await compose(['up', '-d', '--no-deps', 'minio']); }
let state = await admin();
assert.equal(state.deployments[deployment.id].status, 'failed');
assert.equal(state.deployments[deployment.id].step, 'preparing-activation');
assert.equal(state.apps[app].claim.deployment, deployment.id);
const slot = JSON.parse(config.services.controller.environment.FOGD_SLOTS).find(s => s.id === state.apps[app].slot);
await expect.poll(async () => { try { return JSON.parse(await compose(['exec', '-T', 'controller', 'node', '--input-type=module', '-e', `import {Backend} from './packages/platform/src/backend.mjs';console.log(JSON.stringify(await new Backend().owner(${JSON.stringify(slot)})));`])); } catch { return 'unavailable'; } }, { timeout: 120000 }).toBe(null);
await cli(['admin', 'reject', deployment.id, deployment.digest]);
state = await admin(); assert.equal(state.apps[app], undefined);
const rejected = state.deployments[deployment.id]; assert.equal(rejected.status, 'rejected'); assert.equal(rejected.claimRelease.deployment, deployment.id);
const manifest = await backup(join(output, 'snapshot'));
assert.deepEqual(Object.keys(manifest.queueRecovery.apps), ['imports-public']);
await writeFile(join(output, 'claim.json'), JSON.stringify({ project: config.name, image: config.services.controller.image, app, deployment: { id: deployment.id, digest: deployment.digest }, claimRelease: rejected.claimRelease, backupSucceeded: true, preparedApps: Object.keys(manifest.queueRecovery.apps) }, null, 2) + '\n', { mode: 0o600 });
console.log('PASS: failed first queue claim rejected through normal API; backup excludes released queue and prepares active canonical queue');
