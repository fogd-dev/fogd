import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Controller } from '../src/controller.mjs';
import { server } from '../src/http.mjs';

const execute = promisify(execFile);
test('admin API, page and CLI expose capacity without granting deploy credentials access or mutating state', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-capacity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = new Controller({ dir, slots: [{ id: '<script>bad</script>', prefix: 'private-prefix', nodes: ['private-address'] }], backend: { owner: async () => null } });
  await controller.init();
  const before = await readFile(join(dir, 'state.json'), 'utf8');
  const http = server(controller, { user: 'admin', password: 'test-password', deploy: 'deploy', gateway: 'gateway' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const headers = { authorization: `Basic ${Buffer.from('admin:test-password').toString('base64')}` };
  for (const authorization of ['', 'Bearer deploy']) assert.equal((await fetch(origin + '/v1/admin', { headers: { authorization } })).status, 401);
  const state = await (await fetch(origin + '/v1/admin', { headers })).json();
  assert.equal(state.capacity.slots.available, 1);
  const { stdout } = await execute(process.execPath, [fileURLToPath(new URL('../../cli/bin/fogd.js', import.meta.url)), 'admin', 'capacity'], {
    env: { ...process.env, FOGD_ENV_FILE: join(dir, 'absent.env'), FOGD_SERVER: origin, FOGD_ADMIN_USER: 'admin', FOGD_ADMIN_PASSWORD: 'test-password' }, timeout: 10000,
  });
  assert.deepEqual(JSON.parse(stdout), state.capacity);
  const page = await (await fetch(origin + '/', { headers })).text();
  assert.ok(page.includes('1 of 1 app slots available'));
  assert.ok(page.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.ok(!page.includes('<script>bad</script>'));
  for (const secret of ['private-prefix', 'private-address', 'test-password']) {
    assert.ok(!stdout.includes(secret)); assert.ok(!page.includes(secret));
  }
  assert.equal(await readFile(join(dir, 'state.json'), 'utf8'), before);
});
