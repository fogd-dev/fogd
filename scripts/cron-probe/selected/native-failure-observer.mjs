// Fixed diagnostic reader in a separate pinned container, never a controller.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { artifactDigest } from '/app/packages/runtime/src/artifact.mjs';
import { runtimePolicyIdentity } from '/app/packages/platform/src/runtime-policy.mjs';
import { installedRuntimePolicy } from '/app/packages/platform/src/runtime-policy-file.mjs';
import { selectedBackend } from '/app/packages/platform/src/startup.mjs';
import { backendRuntimeIdentity } from '/app/packages/platform/src/backend-runtime-identity.mjs';
import { verifyFailureProof, assertFailureLeases } from './failure-authority.mjs';
import { boundedJson, nativeJson, cliRead, abortNativeReads } from './native-failure-io.mjs';
import { readFailureRecords } from './native-failure-records.mjs';

let env, slotId, deployment, digest, version, mode, time, keys, absentId, backend, policy, fleet, slot, app, artifact, stateSha256;
const startedAt = Date.now(), latencies = {};
const deadline = setTimeout(() => { console.error('FAILURE_OBSERVATION_TIMEOUT'); abortNativeReads(); backend?.s3.destroy(); process.exit(124); }, 25000);
const measured = async (name, run) => { const start = Date.now(); try { return await run(); } finally { latencies[name] = Date.now() - start; } };
const bucket = () => measured('bucket', () => readFailureRecords(backend.s3, policy, fleet));
const ledger = () => measured('ledger', () => cliRead(env, fleet.prefix, ['d1', 'execute', 'refresh-db', '--command', "SELECT * FROM cron_fault_attempts WHERE phase='owner-loss' ORDER BY entered_at,id;", artifact, '--json'], true));
const readers = { 'verify-both': verifyBoth, 'pre-cut': preCut, 'post-cut': postCut, 'quiet-wake': quietWake, 'verify-survivor': verifySurvivor, recovery: recover, 'first-read': firstRead, 'guard-refusal': guardRefusal, 'prepare-waker': prepareWaker, 'prepared-state': preparedState };
try {
  await initialize(); const result = await observe();
  console.log(JSON.stringify({ ...result, mode, slot: slotId, deployment, digest, version, policyIdentity: runtimePolicyIdentity(policy), stateSha256, latencies, startedAt, completedAt: Date.now() }));
} catch (error) {
  console.error(error.code === 'FAILURE_AUTHORITY_REFUSED' ? error.code : 'FAILURE_OBSERVATION_UNCONFIRMED'); process.exitCode = 1;
} finally { clearTimeout(deadline); backend?.s3.destroy(); }

async function initialize() {
  let input = '';
  for await (const part of process.stdin) { input += part; if (Buffer.byteLength(input) > 65536) throw new Error('Observer input exceeds limit'); }
  ({ env, slotId, deployment, digest, version, mode, time, keys, absentId = null } = JSON.parse(input));
  assert.ok(Object.hasOwn(readers, mode));
  assert.match(deployment, /^[a-f0-9-]{36}$/); assert.match(digest, /^[a-f0-9]{64}$/); assert.match(version, /^[a-f0-9]{16,64}$/);
  policy = await installedRuntimePolicy(env); assert.ok(policy); backend = selectedBackend(undefined, policy, env);
  fleet = policy.fleets.find(value => value.id === slotId); slot = JSON.parse(env.FOGD_SLOTS).find(value => value.id === slotId);
  assert.ok(fleet && slot); assert.equal(fleet.nodes.length, 2);
  const bytes = await readFile('/var/lib/fogd/state.json'); stateSha256 = createHash('sha256').update(bytes).digest('hex');
  const state = JSON.parse(bytes), active = state.deployments[deployment]; app = state.apps.refresh;
  assert.ok(app && active && app.active === deployment && app.slot === slotId && active.app === 'refresh' && active.status === 'active');
  assert.equal(active.digest, digest); assert.equal(active.version, version); assert.equal(app.dispatch.version, version);
  const desired = ['prepare-waker', 'prepared-state'].includes(mode) ? 'paused' : 'running';
  assert.equal(app.dispatch.desired, desired); assert.equal(app.dispatch.hold, null); assert.equal(app.dispatch.operation, null); assert.equal(app.uncertain, null);
  assert.ok((desired === 'paused' ? ['paused'] : ['running', 'unknown']).includes(app.dispatch.observed)); assert.equal(active.resources.script, 'refresh');
  assert.equal(active.resources.d1.length, 1); assert.equal(active.resources.d1[0].database_name, 'refresh-db');
  artifact = `/var/lib/fogd/artifacts/${deployment}`; assert.equal(await artifactDigest(artifact), digest);
}

async function observe() {
  if (!['verify-both', 'prepare-waker', 'prepared-state'].includes(mode)) assert.ok(Number.isSafeInteger(time) && time > 0 && time % 60000 === 0);
  return readers[mode]();
}
async function verifyBoth() {
  const hash = createHash('sha256'); for await (const part of createReadStream('/usr/local/bin/celld')) hash.update(part);
  assert.equal(hash.digest('hex'), policy.binarySha256);
  await backendRuntimeIdentity(backend, policy).verify(slot);
  const before = await bucket(), proofs = await Promise.all(fleet.nodes.map(prove)), after = await bucket();
  const authorities = Object.fromEntries(proofs.map(proof => [proof.node, proof.publicKey]));
  checkLeases(before, authorities, null); checkLeases(after, authorities, null);
  const info = await measured('cronInfo', () => cliRead(env, fleet.prefix, ['cron', 'info', 'refresh', '--json']));
  assert.ok(!info.error && info.value.paused === false && Number.isSafeInteger(info.value.nextAlarm));
  return { before, after, proofs, keys: authorities, info: info.value };
}
async function prepareWaker() {
  const records = await bucket(); checkLeases(records, keys, absentId);
  return { bucket: records, recordedDispatch: 'paused' };
}
async function preparedState() {
  assert.equal(absentId, null);
  const before = await bucket(); checkLeases(before, keys, null);
  await backendRuntimeIdentity(backend, policy).verify(slot);
  const replicas = await replicaStates(), after = await bucket(); checkLeases(after, keys, null);
  return { before, bucket: after, replicas };
}
async function replicaStates() {
  return measured('replicaStates', () => Promise.all(fleet.nodes.map(async node => {
    try { return { node: node.id, host: node.host, state: await nativeJson(node.host, '/state') }; }
    catch (error) { if (error instanceof SyntaxError) throw error; return { node: node.id, host: node.host, error: { name: error.name, code: error.cause?.code || error.code || null } }; }
  })));
}
async function quietWake() {
  assert.equal(absentId, null); const records = await bucket();
  return { bucket: records, authorityDeferred: true, observedKeys: Object.fromEntries(records.leases.map(row => [row.expectedNode, row.publicKey])) };
}
async function postCut() {
  assert.ok(absentId !== null); const records = await bucket(); checkLeases(records, keys, absentId); return { bucket: records };
}
async function preCut() {
  assert.equal(absentId, null); assert.equal(app.dispatch.observed, 'running');
  const [records, attempts] = await Promise.all([bucket(), ledger()]); checkLeases(records, keys, null);
  if (attempts.error) return { bucket: records, rows: null, ledger: 'unavailable', ledgerError: attempts.error };
  const owner = fleet.nodes.find(node => node.id === records.owner.node);
  if (!owner) return { bucket: records, rows: attempts.value, selected: attempts.value.filter(row => row.scheduled_time === time), ineligible: 'released-owner' };
  const [info, replicas] = await Promise.all([
    measured('cronInfo', () => cliRead(env, fleet.prefix, ['cron', 'info', 'refresh', '--json'])), replicaStates(),
  ]);
  const ownerState = replicas.find(row => row.node === owner.id);
  return { bucket: records, rows: attempts.value, selected: attempts.value.filter(row => row.scheduled_time === time), info: info.value, infoError: info.error,
    ownerState: ownerState.state?.deployment, ownerStateError: ownerState.error, replicas };
}
async function survivorEvidence() {
  const absent = fleet.nodes.find(node => node.id === absentId), survivor = fleet.nodes.find(node => node.id !== absentId); assert.ok(absent && survivor);
  const before = await bucket(); checkLeases(before, keys, absentId);
  const proof = await prove(survivor); authority(() => assert.equal(proof.publicKey, keys[survivor.id]));
  return { absent, before, proof };
}
async function verifySurvivor() {
  const { absent, before, proof } = await survivorEvidence(); let absentFailure;
  try {
    const response = await fetch(`http://${absent.host}:8082/runtime/identity?challenge=${randomBytes(32).toString('hex')}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    await response.body?.cancel(); throw new Error('Stopped node endpoint unexpectedly reachable');
  } catch (error) { if (error.message === 'Stopped node endpoint unexpectedly reachable') throw error; absentFailure = { name: error.name, code: error.cause?.code || error.code || null }; }
  const after = await bucket(); checkLeases(after, keys, absentId); return { before, after, proof, absentFailure };
}
async function recover() {
  const { before, proof } = await survivorEvidence(), attempts = await ledger(), after = await bucket(); checkLeases(after, keys, absentId);
  return { bucket: after, bucketBefore: before, proof, rows: attempts.value ?? null, ledger: attempts.error ? 'unavailable' : 'available', ledgerError: attempts.error, activeDispatchRequest: true };
}
async function guardRefusal() {
  assert.ok(fleet.nodes.some(node => node.id === absentId));
  try { await backend.crons.status(slot, 'refresh'); }
  catch (error) {
    assert.equal(error.code, 'CRON_RUNTIME_UNVERIFIED');
    assert.equal(error.message, 'Cron runtime identity could not be verified; no command was sent');
    return { refusedBeforeCommand: true, code: error.code, message: error.message };
  }
  throw new Error('Full native guard unexpectedly accepted the unavailable fleet');
}
async function firstRead() {
  assert.equal(absentId, null);
  const before = await bucket();
  const attempts = await measured('ledger', () => cliRead(env, fleet.prefix, ['d1', 'execute', 'refresh-db', '--command', "SELECT * FROM cron_fault_attempts WHERE phase='downtime' ORDER BY entered_at,id;", artifact, '--json'], true));
  const after = await bucket();
  assert.deepEqual(before.leases.map(row => [row.expectedNode, row.publicKey]), after.leases.map(row => [row.expectedNode, row.publicKey]));
  return { before, after, rows: attempts.value ?? null, ledger: attempts.error ? 'unavailable' : 'available', ledgerError: attempts.error, authorityDeferred: true, activeDispatchRequest: true };
}
async function prove(node) {
  const challenge = randomBytes(32).toString('hex');
  const response = await fetch(`http://${node.host}:8082/runtime/identity?challenge=${challenge}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Identity endpoint refused'); }
  const proof = await boundedJson(response.body, 2048);
  return authority(() => verifyFailureProof(policy, slotId, node.id, proof, challenge));
}
function checkLeases(records, authorities, absent) {
  return authority(() => assertFailureLeases(policy, slotId, records.leases, authorities, absent, records.at));
}
function authority(run) {
  try { return run(); } catch { const error = new Error('Failure observer authority refused'); error.code = 'FAILURE_AUTHORITY_REFUSED'; throw error; }
}
