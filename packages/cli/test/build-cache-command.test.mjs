import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { submittedFixture } from './fixtures/build-cache.mjs';
import { recordBuild } from '../src/build-cache/paths.mjs';
const exec = promisify(execFile), cli = new URL('../bin/fogd.js', import.meta.url).pathname, app = 'cache-test';
async function controller(t, fixture) {
  const requests = [], server = createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(fixture.state));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, FOGD_HOME: fixture.home, FOGD_ENV_FILE: join(fixture.home, 'nonexistent.env'), FOGD_SERVER: endpoint, FOGD_ADMIN_USER: 'owner', FOGD_ADMIN_PASSWORD: 'private-owner-test-password' };
  const value = JSON.parse(await readFile(join(fixture.root, 'record.json'), 'utf8'));
  await recordBuild(fixture.root, { ...value, server: endpoint });
  return { env, requests, run: args => exec(process.execPath, [cli, 'builds', ...args], { env }) };
}
test('real CLI previews, pins and prunes through an authenticated current snapshot', async t => {
  const fixture = await submittedFixture(t), host = await controller(t, fixture), plan = join(fixture.home, 'reviewed.json');
  const preview = JSON.parse((await host.run(['plan', app, '--output', plan])).stdout);
  assert.equal(preview.builds[0].decision, 'prune'); assert.equal(preview.sha256.length, 64);
  assert.deepEqual(host.requests, [{ path: '/v1/admin', authorization: 'Basic ' + Buffer.from('owner:private-owner-test-password').toString('base64') }]);
  assert.equal((await readFile(plan, 'utf8')).includes(host.env.FOGD_ADMIN_PASSWORD), false);
  await host.run(['keep', app, fixture.release.localBuildId]);
  const kept = JSON.parse((await host.run(['prune', plan, '--expected-plan', preview.sha256])).stdout);
  assert.equal(kept.results[0].reason, 'operator-kept'); assert.equal(host.requests.length, 1);
  await host.run(['unkeep', app, fixture.release.localBuildId]);
  const result = JSON.parse((await host.run(['prune', plan, '--expected-plan', preview.sha256])).stdout);
  assert.equal(result.results[0].completed, true); assert.equal(host.requests.length, 2);
  assert.equal(JSON.parse((await host.run(['list', app])).stdout).builds.length, 0);
});
test('bad arguments and unreviewed checksum refuse before HTTP or local mutation', async t => {
  const fixture = await submittedFixture(t), host = await controller(t, fixture), before = await readdir(join(fixture.home, '.fogd'));
  for (const args of [['plan', '../escape', '--output', join(fixture.home, 'bad.json')], ['plan', app], ['resume', app, '../escape'], ['keep', app, fixture.release.localBuildId, 'extra'], ['list', app, '--output', 'bad'], ['prune', 'absent', '--expected-plan', 'invalid']]) {
    await assert.rejects(host.run(args));
  }
  const file = join(fixture.home, 'invalid-plan.json'); await writeFile(file, '{}');
  await assert.rejects(host.run(['prune', file, '--expected-plan', '0'.repeat(64)]), error => error.stderr.includes('checksum'));
  assert.equal(host.requests.length, 0); assert.deepEqual(await readdir(join(fixture.home, '.fogd')), before);
});
test('a changed row exits nonzero with actionable results and preserves its bytes', async t => {
  const fixture = await submittedFixture(t), host = await controller(t, fixture), file = join(fixture.home, 'plan.json');
  const plan = JSON.parse((await host.run(['plan', app, '--output', file])).stdout);
  await writeFile(join(fixture.root, 'artifact/worker/index.js'), 'new operator bytes');
  await assert.rejects(host.run(['prune', file, '--expected-plan', plan.sha256]), error => {
    assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).results[0].refused, true); return true;
  });
  assert.equal(await readFile(join(fixture.root, 'artifact/worker/index.js'), 'utf8'), 'new operator bytes');
});
