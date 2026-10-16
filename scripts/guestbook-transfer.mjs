import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compose } from '../packages/cli/src/local.mjs';
import { platformClient } from './platform-client.mjs';
import { transferRequest, privateRequest } from './private-transfer.mjs';

export async function maintenance(client, names, operation) {
  const state = await client.api('/v1/admin');
  const apps = names.map(name => {
    const app = state.apps[name];
    assert.ok(app?.active && app.route === 'active' && !app.quarantined && !app.uncertain, `${name} must be active`);
    assert.equal(app.resources.durable.bindings.length, 0, 'This fixture supports no background writers');
    return app;
  });
  assert.equal(new Set(apps.map(app => app.slot)).size, names.length);
  const services = apps.flatMap(app => [`${app.slot}-a`, `${app.slot}-b`]);
  await compose(['stop', 'workerd'], client.env);
  try {
    await compose(['stop', ...services], client.env);
    await compose(['start', ...services], client.env);
    for (const app of apps) {
      await privateRequest(client.env, { slot: app.slot, ready: state.deployments[app.active].version });
      const result = await transferRequest(client.env, app.slot, '__fogd/export');
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    await operation(apps);
  } catch (error) {
    console.error('Transfer failed. Public ingress remains stopped. Inspect the destination and retry the same snapshot; resume explicitly with docker compose start workerd.');
    throw error;
  }
  await compose(['start', 'workerd'], client.env);
}

export async function transfer(client, names, output) {
  await maintenance(client, names, async ([source, target]) => {
    const exported = await transferRequest(client.env, source.slot, '__fogd/export');
    assert.equal(exported.status, 200);
    try { await writeFile(output, JSON.stringify(exported.body, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), exported.body, 'Existing snapshot differs; choose a new file');
    }
    const restored = await transferRequest(client.env, target.slot, '__fogd/import', exported.body);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const verified = await transferRequest(client.env, target.slot, '__fogd/export');
    assert.equal(verified.status, 200); assert.deepEqual(verified.body, exported.body);
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [source, target, output] = process.argv.slice(2);
  assert.ok(source && target && output, 'Usage: node scripts/guestbook-transfer.mjs SOURCE TARGET NEW_SNAPSHOT_FILE');
  await transfer(await platformClient(), [source, target], output);
  console.log('PASS: guestbook logical transfer verified; ingress resumed');
}
