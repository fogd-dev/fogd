import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { platformClient } from './platform-client.mjs';
import { prepareGrowth } from './prepare-growth.mjs';
import { maintenance, transfer } from './guestbook-transfer.mjs';
import { transferRequest, privateRequest } from './private-transfer.mjs';
import { verifyBrowser, expect } from './guestbook-browser.mjs';
import { uploadAttachment } from './attachment-browser.mjs';
import { stackRoot, compose } from '../packages/cli/src/local.mjs';

const client = await platformClient();
const source = 'guestbook', target = 'restored';
const state = await client.api('/v1/admin');
assert.equal(Object.keys(state.apps).length, 0, 'Use a fresh disposable stack');
async function approve(directory, app) {
  const release = await client.submit(directory, app);
  const result = await client.decide(release);
  assert.equal(result.status, 'active', result.error);
  return release;
}
await approve(join(stackRoot, 'examples/guestbook'), source);
const original = (await client.api('/v1/admin')).apps[source];
assert.deepEqual(original.resources.r2, []);
const message = `Before attachments ${Date.now()}`;
await verifyBrowser(client.browserURL(source), message);
const parent = join(stackRoot, '.fogd/growth'); await mkdir(parent, { recursive: true });
const grown = await prepareGrowth(join(parent, randomUUID()));
const addition = await client.submit(grown, source);
assert.equal(addition.resourceChanges.r2Added.length, 1);
assert.ok((await (await client.appRequest(source, '/api/messages')).json()).some(row => row.text === message));
const active = await client.decide(addition); assert.equal(active.status, 'active', active.error);
assert.deepEqual((await client.api('/v1/admin')).apps[source].resources.d1, original.resources.d1);
const bytes = Buffer.from('A persistent attachment\n\x00\xff', 'latin1');
await uploadAttachment(client.browserURL(source), message, bytes);
await approve(grown, target);
for (const app of [source, target]) {
  for (const path of ['/__fogd/export', '/__fogd/import']) {
    assert.equal((await client.appRequest(app, path, { method: path.endsWith('import') ? 'POST' : 'GET', headers: { 'X-Fogd-Maintenance': '1' } })).status, 404);
  }
}
await maintenance(client, [source, target], async ([from, to]) => {
  const exported = await transferRequest(client.env, from.slot, '__fogd/export');
  assert.equal(exported.status, 200); assert.equal(exported.body.attachments.length, 1);
  await writeFile(join(parent, 'snapshot.json'), JSON.stringify(exported.body, null, 2), { mode: 0o600 });
  const corrupt = structuredClone(exported.body); corrupt.attachments[0].sha256 = '0'.repeat(64);
  assert.equal((await transferRequest(client.env, to.slot, '__fogd/import', corrupt)).status, 400);
  const sql = command => privateRequest(client.env, { slot: to.slot, release: to.active, database: to.resources.d1[0].database_name, sql: command });
  await sql("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 101) INSERT INTO messages(text) SELECT 'export limit fixture' FROM n;");
  const overLimit = await transferRequest(client.env, to.slot, '__fogd/export');
  assert.equal(overLimit.status, 409); assert.match(overLimit.body.error, /100 rows/);
  await sql("DELETE FROM messages WHERE text = 'export limit fixture';");
  await sql("CREATE TRIGGER fail_restore BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'injected restore failure'); END;");
  assert.equal((await transferRequest(client.env, to.slot, '__fogd/import', exported.body)).status, 409);
  const partial = await transferRequest(client.env, to.slot, '__fogd/export');
  assert.equal(partial.status, 200); assert.deepEqual(partial.body.messages, []); assert.deepEqual(partial.body.attachments, []);
  await sql('DROP TRIGGER fail_restore;');
  const retried = await transferRequest(client.env, to.slot, '__fogd/import', exported.body);
  assert.equal(retried.status, 200, JSON.stringify(retried.body)); assert.equal(retried.body.alreadyRestored, false);
  assert.equal((await transferRequest(client.env, to.slot, '__fogd/import', exported.body)).body.alreadyRestored, true);
  const restored = await transferRequest(client.env, to.slot, '__fogd/export');
  assert.deepEqual(restored.body, exported.body);
  const different = structuredClone(exported.body); different.messages[0].text += ' changed';
  assert.equal((await transferRequest(client.env, to.slot, '__fogd/import', different)).status, 409);
});
await transfer(client, [source, target], join(parent, `${addition.id}-export.json`));
await transfer(client, [source, target], join(parent, `${addition.id}-export.json`));
await verifyBrowser(client.browserURL(target), 'Written after restore');
await compose(['restart', 'controller', 'workerd'], client.env);
await expect.poll(async () => {
  try { return (await client.appRequest(target, '/api/messages')).status; } catch { return 0; }
}, { timeout: 30000 }).toBe(200);
for (const app of [source, target]) {
  assert.ok((await (await client.appRequest(app, '/api/messages')).json()).some(row => row.text === message));
  const files = await (await client.appRequest(app, '/api/attachments')).json();
  assert.equal(files.length, 1);
  const download = await client.appRequest(app, `/api/download?id=${files[0].id}`);
  assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
}
console.log('PASS: approved R2 addition, retained D1, browser attachments, quiescent logical transfer, invalid import rejection, interrupted SQL recovery, idempotency, post-restore write, restart');
