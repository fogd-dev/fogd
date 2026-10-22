// Fixed app controls and reads; controller data and installed policy are read-only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { artifactDigest } from '/app/packages/runtime/src/artifact.mjs';
import { installedRuntimePolicy } from '/app/packages/platform/src/runtime-policy-file.mjs';
import { runtimePolicyIdentity } from '/app/packages/platform/src/runtime-policy.mjs';
import { selectedBackend } from '/app/packages/platform/src/startup.mjs';
import { backendRuntimeIdentity } from '/app/packages/platform/src/backend-runtime-identity.mjs';
import { cliRead, nativeJson, abortNativeReads } from './native-failure-io.mjs';
import { readFailureRecords } from './native-failure-records.mjs';

let backend;
const startedAt = Date.now(), deadline = setTimeout(() => { abortNativeReads(); backend?.s3.destroy(); process.exit(124); }, 25000);
try {
  let text = '';
  for await (const part of process.stdin) { text += part; assert.ok(Buffer.byteLength(text) <= 65536); }
  const { env, slotId, deployment, digest, version, mode, pending, policyIdentity } = JSON.parse(text);
  assert.ok(['observe', 'arm-old', 'arm-new', 'release-old'].includes(mode));
  assert.match(deployment, /^[a-f0-9-]{36}$/); assert.match(digest, /^[a-f0-9]{64}$/); assert.match(version, /^[a-f0-9]{16,64}$/);
  const policy = await installedRuntimePolicy(env); assert.equal(runtimePolicyIdentity(policy), policyIdentity);
  backend = selectedBackend(undefined, policy, env);
  const fleet = policy.fleets.find(value => value.id === slotId), slot = JSON.parse(env.FOGD_SLOTS).find(value => value.id === slotId); assert.ok(fleet && slot);
  const bytes = await readFile('/var/lib/fogd/state.json'), stateSha256 = createHash('sha256').update(bytes).digest('hex'), state = JSON.parse(bytes);
  const app = state.apps.refresh, active = state.deployments[deployment], artifact = `/var/lib/fogd/artifacts/${deployment}`;
  assert.ok(app && active && app.active === deployment && app.slot === slotId && active.status === 'active' && active.app === 'refresh');
  assert.equal(active.digest, digest); assert.equal(active.version, version); assert.equal(active.resources.script, 'refresh');
  assert.equal(active.resources.d1.length, 1); assert.equal(active.resources.d1[0].database_name, 'refresh-db');
  assert.equal(await artifactDigest(artifact), digest);
  await backendRuntimeIdentity(backend, policy).verify(slot);
  const execute = async sql => {
    // cliRead supplies bounded CLI execution for both fixed reads and controls.
    const result = await cliRead(env, fleet.prefix, ['d1', 'execute', 'refresh-db', '--command', sql, artifact, '--json'], true);
    assert.ok(!result.error, 'Replacement D1 observation unavailable'); assert.ok(result.value.length <= 500); return result.value;
  };
  const info = mode === 'observe' ? await backend.crons.status(slot, 'refresh') : await backend.crons.snapshot(slot, 'refresh', version);
  let control;
  if (mode.startsWith('arm-')) {
    assert.equal(app.dispatch.hold, null); assert.equal(app.dispatch.operation, null); assert.equal(app.uncertain, null);
    assert.equal(app.dispatch.desired, 'paused'); assert.equal(app.dispatch.observed, 'paused'); assert.equal(app.dispatch.version, version);
    assert.equal(info.paused, true); assert.equal(info.nextAlarm, null);
    assert.deepEqual(await execute("SELECT count(*) AS pending FROM cron_replacement_attempts WHERE outcome='pending';"), [{ pending: 0 }]);
    const release = mode === 'arm-old' ? 'old' : 'new', inventory = mode === 'arm-old' ? 'none' : 'after', at = Date.now();
    control = await execute(`UPDATE cron_replacement_control SET armed_after = ${at}, held_time = NULL, released = 0, hold_release = '${release}', position = 'before', inventory_position = '${inventory}' WHERE id = 1 RETURNING *;`);
    assert.equal(control.length, 1); assert.equal(control[0].armed_after, at);
  } else if (mode === 'release-old') {
    assert.match(pending.id, /^[a-f0-9-]{36}$/); assert.match(pending.digest, /^[a-f0-9]{64}$/);
    assert.match(pending.attempt, /^[a-f0-9-]{36}$/);
    assert.ok(Number.isSafeInteger(pending.time) && pending.time > 0 && pending.time % 60000 === 0);
    const next = state.deployments[pending.id];
    assert.ok(next && next.app === 'refresh' && next.status === 'activating' && next.step === 'publishing');
    assert.equal(next.digest, pending.digest); assert.equal(next.secretRevision, active.secretRevision);
    assert.equal(await artifactDigest(`/var/lib/fogd/artifacts/${pending.id}`), pending.digest);
    assert.equal(app.dispatch.hold, pending.id); assert.equal(app.dispatch.observed, 'paused'); assert.equal(app.dispatch.operation, null);
    assert.equal(info.paused, true); assert.equal(info.nextAlarm, null);
    assert.deepEqual(await execute("SELECT name FROM d1_migrations WHERE name='0003_compatible.sql';"), [{ name: '0003_compatible.sql' }]);
    assert.deepEqual(await execute('SELECT hold_release,released FROM cron_replacement_control WHERE id=1;'), [{ hold_release: 'old', released: 0 }]);
    control = await execute(`UPDATE cron_replacement_control SET released=1 WHERE id=1 AND released=0 AND hold_release='old' AND held_time=${pending.time}
      AND (SELECT count(*) FROM cron_replacement_attempts WHERE outcome='pending' AND held_at IS NOT NULL)=1
      AND EXISTS(SELECT 1 FROM cron_replacement_attempts WHERE id='${pending.attempt}' AND release='old' AND job='advisory' AND outcome='pending' AND held_at IS NOT NULL AND scheduled_time=cron_replacement_control.held_time) RETURNING *;`);
    assert.equal(control.length, 1); assert.equal(control[0].released, 1);
  }
  const tables = { attempts: 'cron_replacement_attempts ORDER BY entered_at,id', results: 'refresh_results ORDER BY scheduled_time,job',
    occurrences: 'refresh_occurrences ORDER BY scheduled_time,job', control: 'cron_replacement_control ORDER BY id', migrations: 'd1_migrations ORDER BY name' };
  const entries = await Promise.all(Object.entries(tables).map(async ([name, table]) => [name, await execute(`SELECT * FROM ${table};`)]));
  const [bucket, replicas] = await Promise.all([readFailureRecords(backend.s3, policy, fleet), Promise.all(fleet.nodes.map(async node => ({ node: node.id, host: node.host, state: await nativeJson(node.host, '/state') })))]);
  for (const replica of replicas) assert.equal(replica.state.deployment.version, version);
  console.log(JSON.stringify({ ...Object.fromEntries(entries), mutation: control, info, bucket, replicas, mode, deployment, digest, version, stateSha256,
    policyIdentity: runtimePolicyIdentity(policy), startedAt, completedAt: Date.now() }));
} catch { console.error('REPLACEMENT_OBSERVATION_UNCONFIRMED'); process.exitCode = 1; }
finally { clearTimeout(deadline); backend?.s3.destroy(); }
