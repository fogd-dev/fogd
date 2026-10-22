// Fixed read-only diagnostics for a recorded operator pause with one absent member.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { artifactDigest } from '/app/packages/runtime/src/artifact.mjs';
import { installedRuntimePolicy } from '/app/packages/platform/src/runtime-policy-file.mjs';
import { selectedBackend } from '/app/packages/platform/src/startup.mjs';
import { backendRuntimeIdentity } from '/app/packages/platform/src/backend-runtime-identity.mjs';
import { runtimePolicyIdentity } from '/app/packages/platform/src/runtime-policy.mjs';
import { verifyFailureProof, assertFailureLeases } from './failure-authority.mjs';
import { readFailureRecords } from './native-failure-records.mjs';
import { boundedJson, cliRead, abortNativeReads } from './native-failure-io.mjs';
import { assertPauseUnconfirmed } from './pause-state.mjs';

let backend, stage = 'initialize';
const deadline = setTimeout(() => { abortNativeReads(); backend?.s3.destroy(); process.exit(124); }, 25000);
try {
  let text = '';
  for await (const part of process.stdin) { text += part; assert.ok(Buffer.byteLength(text) <= 65536); }
  const { env, active, absentId = null, keys = null, pending = false } = JSON.parse(text), startedAt = Date.now();
  assert.equal(active.app, 'refresh'); assert.match(active.id, /^[a-f0-9-]{36}$/); assert.match(active.digest, /^[a-f0-9]{64}$/); assert.match(active.version, /^[a-f0-9]{16,64}$/);
  const policy = await installedRuntimePolicy(env), fleet = policy.fleets.find(value => value.id === active.slot);
  assert.ok(fleet && fleet.nodes.length === 2); assert.ok(absentId === null || fleet.nodes.some(node => node.id === absentId));
  backend = selectedBackend(undefined, policy, env);
  const bytes = await readFile('/var/lib/fogd/state.json'), state = JSON.parse(bytes), app = state.apps.refresh, request = state.deployments[active.id];
  assert.equal(app.dispatch.version, active.version); assert.equal(app.dispatch.hold, null); assert.equal(app.uncertain, null); assert.equal(app.route, 'active');
  assert.equal(app.active, active.id); assert.equal(app.slot, active.slot); assert.equal(request.status, 'active');
  for (const key of ['digest', 'version', 'secretRevision']) assert.equal(request[key], active[key]);
  assert.equal(await artifactDigest('/var/lib/fogd/artifacts/' + active.id), active.digest);
  if (pending) assertPauseUnconfirmed(app, active);
  const slot = JSON.parse(env.FOGD_SLOTS).find(value => value.id === active.slot);
  if (absentId === null) await backendRuntimeIdentity(backend, policy).verify(slot);
  stage = 'identity';
  const absent = fleet.nodes.find(node => node.id === absentId), absentFailure = absent ? await unavailable(absent) : null;
  const before = await readFailureRecords(backend.s3, policy, fleet), proofs = [];
  for (const node of fleet.nodes.filter(node => node.id !== absentId)) {
    const challenge = randomBytes(32).toString('hex');
    const response = await fetch(`http://${node.host}:8082/runtime/identity?challenge=${challenge}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    assert.equal(response.ok, true); const proof = await boundedJson(response.body, 2048);
    proofs.push(verifyFailureProof(policy, active.slot, node.id, proof, challenge));
  }
  const authority = keys || Object.fromEntries(proofs.map(value => [value.node, value.publicKey]));
  assertFailureLeases(policy, active.slot, before.leases, authority, absentId, before.at);
  for (const proof of proofs) assert.equal(proof.publicKey, authority[proof.node]);
  const artifact = '/var/lib/fogd/artifacts/' + active.id;
  stage = 'ledger'; const data = {};
  for (const [table, order] of Object.entries({ cron_fault_attempts: 'entered_at,id', refresh_occurrences: 'scheduled_time,job', refresh_results: 'scheduled_time,job', cron_fault_control: 'id', refresh_settings: 'id' })) {
    const value = await cliRead(env, fleet.prefix, ['d1', 'execute', 'refresh-db', '--command', `SELECT * FROM ${table} ORDER BY ${order};`, artifact, '--json'], true);
    assert.ok(!value.error); data[table] = value.value;
  }
  stage = 'status'; const info = await cliRead(env, fleet.prefix, ['cron', 'info', 'refresh', '--json']); assert.ok(!info.error);
  const after = await readFailureRecords(backend.s3, policy, fleet);
  assertFailureLeases(policy, active.slot, after.leases, authority, absentId, after.at);
  console.log(JSON.stringify({ startedAt, completedAt: Date.now(), policyIdentity: runtimePolicyIdentity(policy), stateSha256: createHash('sha256').update(bytes).digest('hex'), dispatch: app.dispatch, info: info.value, before, after, absentFailure, proofs, keys: authority, data }));
} catch { console.error('PAUSE_OBSERVATION_UNCONFIRMED:' + stage); process.exitCode = 1; }
finally { clearTimeout(deadline); backend?.s3.destroy(); }

async function unavailable(node) {
  const result = await fetch(`http://${node.host}:8082/runtime/identity?challenge=${randomBytes(32).toString('hex')}`, { redirect: 'error', signal: AbortSignal.timeout(5000) }).then(async response => {
    await response.body?.cancel(); return { reachable: true, status: response.status };
  }, error => ({ reachable: false, error: { name: error.name, code: error.cause?.code || error.code || null } }));
  assert.equal(result.reachable, false); return result;
}
