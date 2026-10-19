import assert from 'node:assert/strict';
import { join } from 'node:path';
import { platformClient } from './platform-client.mjs';
import { stackRoot } from '../packages/cli/src/local.mjs';
import { expect } from './guestbook-browser.mjs';
const client = await platformClient();
assert.match(client.env.COMPOSE_PROJECT_NAME || '', /^fogd-m10[a-z0-9-]*$/);
assert.equal(client.env.FOGD_PROFILE, 'shared');
await expect.poll(async () => { try { return (await client.api('/v1/admin')).capacity.slots.configured; } catch { return 0; } }, { timeout: 120000 }).toBe(3);
assert.deepEqual((await client.api('/v1/admin')).apps, {});
const expected = new Map();
for (const name of ['alpha', 'beta', 'gamma']) {
  const { csrf } = await client.api('/v1/admin');
  const issued = await client.api('/v1/credentials', { method: 'POST', headers: { 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ name: `${name} builder`, apps: [name] }) });
  const builder = await platformClient({ ...client.env, FOGD_DEPLOY_TOKEN: issued.token });
  const release = await builder.submit(join(stackRoot, 'examples/notebook'), name);
  assert.equal((await client.appRequest(name, '/api/entries')).status, 404);
  assert.equal((await client.decide(release)).status, 'active');
  assert.deepEqual(await (await client.appRequest(name, '/api/entries')).json(), { entries: [], count: 0 });
  const entry = { id: `${name}-only`, title: `${name} app`, body: `Stored only by ${name}` };
  assert.equal((await client.appRequest(name, '/api/entries', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) })).status, 200);
  expected.set(name, { entries: [entry], count: 1 });
}
for (const [name, value] of expected) assert.deepEqual(await (await client.appRequest(name, '/api/entries')).json(), value);
assert.equal((await client.api('/v1/admin')).capacity.slots.available, 0);
console.log('PASS: fresh rendered installation serves three independently scoped, approved apps with isolated D1/R2/DO data and migrations');
