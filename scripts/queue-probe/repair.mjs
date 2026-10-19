import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller } from '/app/packages/platform/src/controller.mjs';
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { server } from '/app/packages/platform/src/http.mjs';
import { deliveryFor } from '/app/packages/platform/src/queue-activation.mjs';
import { translateConfig } from '/app/packages/runtime/src/artifact.mjs';
import { stageRequest } from './controller-artifact.mjs';

const [source, slotId] = process.argv.slice(2);
const slot = JSON.parse(process.env.FOGD_SLOTS).find(slot => slot.id === slotId);
assert.ok(slot); const backend = new Backend();
assert.equal(await backend.owner(slot), null); assert.equal(await backend.hasDeployment(slot), false);
const dir = join(process.env.FOGD_DATA_DIR || '/var/lib/fogd', `repair-${randomUUID()}`);
const c = new Controller({ queueApps: true, dir, slots: [slot], backend }); await c.init();
const password = randomUUID(), http = server(c, { user: 'probe', password, gateway: randomUUID(), deploy: randomUUID() });
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${http.address().port}`, headers = { authorization: `Basic ${Buffer.from(`probe:${password}`).toString('base64')}` };
const { csrf } = await (await fetch(origin + '/v1/admin', { headers })).json();
try {
  const old = await stage(false, false);
  const failed = await approve(old); assert.equal(failed.status, 200); assert.equal(old.status, 'failed', old.error);
  assert.equal(old.step, 'migrating'); assert.equal(c.state.apps[old.app].uncertain, old.id);
  assert.deepEqual(await rows(old), [], 'First insert in failing file must roll back');
  const originalStep = old.step;
  const invalid = await stage(true, true);
  const rejected = await approve(invalid, old); assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /Applied migration changed/);
  assert.equal(c.state.apps[old.app].delivery.hold, old.id); assert.equal(old.step, originalStep);
  assert.equal(c.state.apps[old.app].migrations.length, 2);
  const corrected = await stage(true, false);
  const accepted = await approve(corrected, old); assert.equal(accepted.status, 200); assert.equal(corrected.status, 'active', corrected.error);
  assert.equal(c.state.apps[old.app].migrations.length, 3); assert.equal(c.state.apps[old.app].uncertain, null);
  assert.deepEqual(await rows(corrected), [{ marker: 'corrected' }]);
  await c.exclusive(() => deliveryFor(c, c.state.apps[old.app], slot).pause());
  console.log(JSON.stringify({ dir, slot: slot.id, original: { id: old.id, digest: old.digest, step: originalStep }, corrected: { id: corrected.id, digest: corrected.digest, replaces: corrected.replaces, status: corrected.status }, migrations: c.state.apps[old.app].migrations, auditRows: await rows(corrected), firstInsertRolledBack: true, appliedSqlChangeRejected: true, queue: await backend.queues.status(slot, 'imports') }));
} finally { await new Promise(resolve => http.close(resolve)); }

async function stage(corrected, changeApplied) {
  return stageRequest(c, source, async (artifact, config) => {
    const queues = config.queues;
    Object.assign(config, translateConfig({ ...config, queues: undefined }, 'imports-repair'), { queues });
    const migrationDir = join(artifact, config.d1_databases[0].migrations_dir);
    await writeFile(join(migrationDir, '0002_audit.sql'), `${changeApplied ? '-- changed applied SQL\n' : ''}CREATE TABLE repair_audit (marker TEXT NOT NULL);\n`);
    await writeFile(join(migrationDir, '0003_repair.sql'), corrected ? "INSERT INTO repair_audit VALUES ('corrected');\n" : "INSERT INTO repair_audit VALUES ('must-roll-back');\nNOT VALID SQL;\n");
  });
}
function approve(request, old) {
  return fetch(`${origin}/v1/deployments/${request.id}/approve`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ digest: request.digest, ...(old ? { replaces: { deployment: old.id, digest: old.digest } } : {}) }) });
}
async function rows(request) {
  const result = await backend.run(slot, ['d1', 'execute', request.resources.d1[0].database_name, '--command', 'SELECT marker FROM repair_audit;', c.artifact(request.id), '--json']);
  return result.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
