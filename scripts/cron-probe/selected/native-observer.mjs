// Executed from stdin in a separate pinned-image process; never starts a controller.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { installedRuntimePolicy } from '/app/packages/platform/src/runtime-policy-file.mjs';
import { selectedBackend } from '/app/packages/platform/src/startup.mjs';
import { backendRuntimeIdentity } from '/app/packages/platform/src/backend-runtime-identity.mjs';
import { verifyIdentityProof } from '/app/packages/platform/src/runtime-identity-proof.mjs';
import { activationQueue } from '/app/packages/platform/src/queue-activation.mjs';

let text = '';
for await (const part of process.stdin) { text += part; if (text.length > 65536) throw new Error('Observer input exceeds limit'); }
const { env, slotId, deployment, captureProofs, persistedRecords } = JSON.parse(text), policy = await installedRuntimePolicy(env);
const backend = selectedBackend(undefined, policy, env), slot = JSON.parse(env.FOGD_SLOTS).find(value => value.id === slotId);
if (!slot) throw new Error('Unknown observation fleet');
const identity = backendRuntimeIdentity(backend, policy);
const { GetObjectCommand, ListObjectsV2Command } = createRequire('/app/packages/platform/package.json')('@aws-sdk/client-s3');
const proofs = captureProofs ? await collectProofs() : undefined;
if (!deployment) {
  await identity.bootstrap(slot);
  const inventory = await backend.s3.send(new ListObjectsV2Command({ Bucket: env.FOGD_BUCKET, Prefix: `${slot.prefix}/deploy/`, MaxKeys: 1 }), { abortSignal: AbortSignal.timeout(5000) });
  console.log(JSON.stringify({ slot: slot.id, bootstrapVerified: true, count: inventory.KeyCount, truncated: inventory.IsTruncated, keys: (inventory.Contents || []).map(value => value.Key), proofs }));
} else {
  if (!/^[a-f0-9-]{36}$/.test(deployment)) throw new Error('Invalid deployment identity');
  const state = JSON.parse(await readFile('/var/lib/fogd/state.json', 'utf8')), request = state.deployments[deployment];
  if (!request || state.apps[request.app]?.slot !== slot.id) throw new Error('Deployment is outside the observed fleet');
  await identity.verify(slot);
  const cronRecords = persistedRecords && request.resources.crons ? await persistedCron(request.resources.script) : undefined;
  const status = await applicationStatus(request);
  const queuePeek = persistedRecords && request.resources.queues
    ? JSON.parse((await backend.run(slot, ['queue', 'peek', activationQueue(request.resources), '--limit', '17', '--json'])).trim()) : undefined;
  if (queuePeek && (!Array.isArray(queuePeek.messages) || queuePeek.messages.length > 16)) throw new Error('Queue observation exceeds the bounded fixture limit');
  if (queuePeek && status.paused && queuePeek.messages.length !== status.backlogCount) throw new Error('Held queue observation is incomplete');
  const databases = [];
  for (const database of request.resources.d1) {
    const sql = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;";
    const output = await backend.run(slot, ['d1', 'execute', database.database_name, '--command', sql, `/var/lib/fogd/artifacts/${deployment}`, '--json']);
    const rows = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), data = {};
    const ledger = await backend.run(slot, ['d1', 'execute', database.database_name, '--command', 'SELECT name FROM d1_migrations ORDER BY name;', `/var/lib/fogd/artifacts/${deployment}`, '--json']);
    const migrations = ledger.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    for (const [table, order] of Object.entries({ refresh_settings: 'id', refresh_occurrences: 'scheduled_time, job', refresh_results: 'scheduled_time, job',
      cron_fault_control: 'id', cron_fault_attempts: 'entered_at, id', import_jobs: 'id', import_results: 'job_id, position' })) {
      if (!rows.some(row => row.name === table)) continue;
      const records = await backend.run(slot, ['d1', 'execute', database.database_name, '--command', `SELECT * FROM ${table} ORDER BY ${order};`, `/var/lib/fogd/artifacts/${deployment}`, '--json']);
      data[table] = records.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    }
    databases.push({ database: database.database_id, rows, migrations, data });
  }
  const stored = await storedDeployment(request.resources.script);
  const replicas = await Promise.all(slot.nodes.map(async node => { const deployment = await backend.deployment(node); return { node, version: deployment?.version, generation: deployment?.generation }; }));
  console.log(JSON.stringify({ slot: slot.id, identityVerified: true, status, databases, stored, replicas, proofs, cronRecords, queuePeek }));
}

async function applicationStatus(request) {
  if (request.resources.crons) return backend.crons.status(slot, request.resources.script);
  const queue = activationQueue(request.resources);
  if (!queue) throw new Error('Observer requires a scheduled or queued fixture');
  return backend.queues.status(slot, queue);
}

async function persistedCron(script) {
  const cell = `.cron:${script}`;
  const listing = await backend.s3.send(new ListObjectsV2Command({ Bucket: env.FOGD_BUCKET, Prefix: `${slot.prefix}/wake/entries/`, MaxKeys: 256 }), { abortSignal: AbortSignal.timeout(5000) });
  if (listing.IsTruncated) throw new Error('Persisted wake inventory is truncated');
  const wakes = [];
  for (const object of listing.Contents || []) {
    try { const row = JSON.parse(await objectText(object.Key.slice(slot.prefix.length + 1))); if (row.cell === cell) wakes.push({ key: object.Key, ...row }); }
    catch (error) { if (error.$metadata?.httpStatusCode !== 404) throw error; }
  }
  return { wakes, at: Date.now() };
}

async function storedDeployment(script) {
  const pointer = JSON.parse(await objectText(`deploy/${script}/current.json`));
  if (!/^[a-f0-9]{16,64}$/.test(pointer.version) || pointer.prefix !== `deploy/${script}/${pointer.version}`) throw new Error('Unexpected stored deployment pointer');
  const text = await objectText(`${pointer.prefix}/manifest.json`), manifest = JSON.parse(text);
  if (manifest.script_name !== script || manifest.version !== pointer.version) throw new Error('Stored deployment manifest identity mismatch');
  return { pointer, manifestSha256: createHash('sha256').update(text).digest('hex'), manifest: { script: manifest.script_name, version: manifest.version, crons: manifest.crons || [] } };
}
async function objectText(key) {
  const object = await backend.s3.send(new GetObjectCommand({ Bucket: env.FOGD_BUCKET, Key: `${slot.prefix}/${key}` }), { abortSignal: AbortSignal.timeout(5000) });
  const text = await object.Body.transformToString();
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Observer object exceeds limit');
  return text;
}
async function collectProofs() {
  await identity.bootstrap(slot);
  const before = await identity.members(slot), observedAt = Date.now(), values = [];
  for (const node of policy.fleets.find(fleet => fleet.id === slot.id).nodes) {
    const challenge = randomBytes(32).toString('hex');
    const response = await fetch(`http://${node.host}:8082/runtime/identity?challenge=${challenge}`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Independent identity observation refused');
    const proof = await response.json(); verifyIdentityProof(proof, challenge);
    values.push({ host: node.host, node: node.id, challenge, proof });
  }
  return { observedAt, before, values, after: await identity.members(slot) };
}
