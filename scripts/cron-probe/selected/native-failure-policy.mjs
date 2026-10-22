// Private app-only fault controls; installed controller/runtime policy is read-only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { installedRuntimePolicy } from '/app/packages/platform/src/runtime-policy-file.mjs';
import { selectedBackend } from '/app/packages/platform/src/startup.mjs';
import { artifactDigest } from '/app/packages/runtime/src/artifact.mjs';

let text = '';
for await (const part of process.stdin) { text += part; if (text.length > 65536) throw new Error('Operator input exceeds limit'); }
const { env, slotId, deployment, digest, version, phase } = JSON.parse(text);
const policies = { 'offline-minute': 'healthy', 'offline-sparse': 'healthy', baseline: 'healthy', 'retry-control': 'owner-loss', 'no-retry': 'no-retry', 'no-retry-future': 'healthy', 'owner-loss': 'owner-loss', 'owner-loss-future': 'healthy', terminal: 'terminal', 'terminal-future': 'healthy', downtime: 'healthy', 'ui-offline': 'healthy', 'ui-healthy': 'healthy' };
assert.ok(Object.hasOwn(policies, phase)); assert.match(deployment, /^[a-f0-9-]{36}$/); assert.match(digest, /^[a-f0-9]{64}$/); assert.match(version, /^[a-f0-9]{16,64}$/);
const installed = await installedRuntimePolicy(env), backend = selectedBackend(undefined, installed, env);
const slot = JSON.parse(env.FOGD_SLOTS).find(value => value.id === slotId);
const state = JSON.parse(await readFile('/var/lib/fogd/state.json', 'utf8')), app = state.apps.refresh, active = state.deployments[deployment];
assert.ok(slot && app?.slot === slotId && app.active === deployment && active?.app === 'refresh' && active.status === 'active');
assert.equal(active.digest, digest); assert.equal(active.version, version); assert.equal(app.dispatch.version, version);
assert.ok(app.dispatch.desired === 'paused' && app.dispatch.observed === 'paused' && app.dispatch.operation === null && app.dispatch.hold === null);
assert.ok(!app.cronRecovery || app.cronRecovery.status === 'acknowledged');
const artifact = `/var/lib/fogd/artifacts/${deployment}`; assert.equal(await artifactDigest(artifact), digest);
const native = await backend.crons.snapshot(slot, 'refresh', version); assert.equal(native.paused, true); assert.equal(native.nextAlarm, null);
assert.equal(active.resources.d1.length, 1); const database = active.resources.d1[0].database_name;
const execute = sql => backend.run(slot, ['d1', 'execute', database, '--command', sql, artifact, '--json']).then(output => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
const mode = phase === 'ui-offline' ? 'offline' : 'healthy';
assert.deepEqual(await execute("SELECT count(*) AS pending FROM cron_fault_attempts WHERE outcome='pending'; SELECT mode FROM refresh_settings WHERE id=1;"), [{ pending: 0 }, { mode }]);
const policy = policies[phase];
assert.deepEqual(await execute(`UPDATE cron_fault_control SET policy='${policy}',phase='${phase}' WHERE id=1; SELECT policy,phase FROM cron_fault_control WHERE id=1; SELECT mode FROM refresh_settings WHERE id=1;`), [{ policy, phase }, { mode }]);
console.log(JSON.stringify({ policy, phase, mode, native, at: Date.now() }));
