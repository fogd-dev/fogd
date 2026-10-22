// Trusted operator action on a private application fixture, never controller state.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installedRuntimePolicy } from '/app/packages/platform/src/runtime-policy-file.mjs';
import { selectedBackend } from '/app/packages/platform/src/startup.mjs';

let text = '';
for await (const part of process.stdin) { text += part; if (text.length > 65536) throw new Error('Operator input exceeds limit'); }
const { env, slotId, deployment, policy, phase } = JSON.parse(text);
if (!['healthy', 'terminal'].includes(policy) || !['snapshot-a', 'after-a', 'retry-b', 'after-b', 'older-a'].includes(phase)) throw new Error('Unsupported fixture policy');
if (!/^[a-f0-9-]{36}$/.test(deployment)) throw new Error('Invalid fixture deployment');
const installed = await installedRuntimePolicy(env), backend = selectedBackend(undefined, installed, env);
const slot = JSON.parse(env.FOGD_SLOTS).find(slot => slot.id === slotId);
const state = JSON.parse(await readFile('/var/lib/fogd/state.json', 'utf8')), app = state.apps.refresh, request = state.deployments[deployment];
assert.ok(slot && app?.slot === slot.id && app.active === deployment && request?.app === 'refresh' && request.status === 'active');
assert.ok(app.dispatch.desired === 'paused' && app.dispatch.observed === 'paused' && app.dispatch.operation === null && app.dispatch.hold === null);
assert.ok(!app.cronRecovery || app.cronRecovery.status === 'acknowledged');
await backend.crons.snapshot(slot, 'refresh', request.version);
assert.equal(request.resources.d1.length, 1);
const database = request.resources.d1[0];
const sql = `UPDATE refresh_settings SET mode='healthy' WHERE id=1; UPDATE cron_fault_control SET policy='${policy}',phase='${phase}' WHERE id=1; SELECT policy,phase FROM cron_fault_control WHERE id=1; SELECT mode FROM refresh_settings WHERE id=1;`;
const output = await backend.run(slot, ['d1', 'execute', database.database_name, '--command', sql, `/var/lib/fogd/artifacts/${deployment}`, '--json']);
const observed = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
assert.deepEqual(observed, [{ policy, phase }, { mode: 'healthy' }]);
console.log(JSON.stringify({ policy, phase, at: Date.now() }));
