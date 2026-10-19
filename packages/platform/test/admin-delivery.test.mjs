import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Controller } from '../src/controller.mjs';
import { QueueRuntime, queueCell } from '../src/queue-runtime.mjs';
import { server } from '../src/http.mjs';
import { initialDelivery } from '../src/delivery.mjs';
import { queueCapability } from '../src/queue-activation.mjs';
import { saveJson } from '../src/store.mjs';
import { randomUUID } from 'node:crypto';
import { recoveryReview, recoverQueueSnapshots } from '../src/queue-recovery.mjs';
import { queueRecoveryCapability } from '../src/queue-snapshot.mjs';

const execute = promisify(execFile);
const id = 'f2e116e5-df28-4fea-bc21-19ada020970a', digest = 'a'.repeat(64);
const version = 'private-materialized-version';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-admin-delivery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = []; let paused = false, runtimeVersion = version, fail = null, diskFailure = false;
  const queues = new QueueRuntime({
    async run(_slot, args) {
      if (args[0] === '--version') return 'celld 0.6.2';
      const verb = args[1]; calls.push(verb);
      if (verb !== 'info') paused = verb === 'pause';
      if (fail === verb) { fail = null; throw Error('private-runtime-diagnostic'); }
      return JSON.stringify({ paused, stored: 0, backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: null });
    },
    async inspect(node) { return { version: runtimeVersion, generation: 3, cells: node === 'a' ? { [queueCell('jobs')]: 3 } : {} }; },
  });
  const c = new Controller({ dir, slots: [{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }], backend: { owner: async () => null, queues },
    persist: async (path, value) => { if (diskFailure) throw Error('disk failed'); await saveJson(path, value); }, reportStorageFailure: () => {} });
  await c.init();
  c.state.requirements = [queueCapability];
  c.state.deployments[id] = { id, app: 'imports', digest, status: 'active', version, secretRevision: 'revision', requiredSecrets: ['SECRET'] };
  c.state.apps.imports = { slot: 'one', active: id, route: 'active', resources: { queues: { producers: [{ queue: 'jobs' }], consumers: [{ queue: 'jobs' }] } },
    delivery: { ...initialDelivery('jobs', id), hold: null, version, observed: 'running', observedAt: new Date().toISOString() }, queueBootstrap: { phase: 'application', version: 'private-bootstrap-version' } };
  await c.save();
  const credentials = { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' };
  const http = server(c, credentials); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const auth = { authorization: `Basic ${Buffer.from('admin:password').toString('base64')}` };
  const state = await (await fetch(origin + '/v1/admin', { headers: auth })).json();
  const path = '/v1/apps/imports/delivery';
  const post = (action, body = {}, headers = {}) => fetch(origin + path + '/' + action, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': state.csrf, ...headers }, body: JSON.stringify(body) });
  return { c, calls, origin, auth, path, post, credentials, paused: () => paused,
    stale: () => { runtimeVersion = 'other-version'; }, fail: action => { fail = action; }, diskFail: () => { diskFailure = true; } };
}

test('admin delivery API, page, and CLI redact versions and recorded GET status has no runtime effects', async t => {
  const f = await fixture(t), before = await readFile(join(f.c.dir, 'state.json'), 'utf8');
  for (const path of [f.path, '/v1/admin', '/']) {
    const response = await fetch(f.origin + path, { headers: f.auth });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const text = await response.text(); assert.equal(text.includes(version), false); assert.equal(text.includes('private-bootstrap-version'), false);
    if (path === '/') { assert.match(text, /Refresh status/); assert.match(text, /Pause does not drain/); }
  }
  const cli = async args => execute(process.execPath, [fileURLToPath(new URL('../../cli/bin/fogd.js', import.meta.url)), 'admin', 'delivery', 'imports', ...args], {
    env: { ...process.env, FOGD_ENV_FILE: join(f.c.dir, 'absent.env'), FOGD_SERVER: f.origin, FOGD_ADMIN_USER: 'admin', FOGD_ADMIN_PASSWORD: 'password' }, timeout: 10000,
  });
  assert.equal(JSON.parse((await cli([])).stdout).desired, 'running');
  assert.deepEqual(f.calls, []); assert.equal(await readFile(join(f.c.dir, 'state.json'), 'utf8'), before);
  assert.equal(JSON.parse((await cli(['pause'])).stdout).desired, 'paused');
  assert.equal(f.paused(), true);
  await assert.rejects(cli(['resume']), /requires/);
  await assert.rejects(cli(['resume', 'different', digest]), /deployment\/digest changed/);
  await assert.rejects(cli(['resume', id, digest, 'extra']), /Too many/);
  assert.equal(JSON.parse((await cli(['resume', id, digest])).stdout).observed, 'running');
  assert.equal(f.paused(), false);
  assert.equal(f.c.state.apps.imports.delivery.version, version);
});

test('delivery operations require admin credentials, CSRF, same origin, and stay off internal listener', async t => {
  const f = await fixture(t);
  for (const authorization of ['', 'Bearer deploy', 'Bearer gateway']) {
    assert.equal((await fetch(f.origin + f.path, { headers: { authorization } })).status, 401);
    assert.equal((await f.post('pause', {}, { authorization })).status, 401);
  }
  assert.equal((await f.post('observe', {}, { 'X-Fogd-CSRF': '' })).status, 403);
  assert.equal((await f.post('pause', {}, { origin: 'https://evil.test' })).status, 403);
  const internal = server(f.c, f.credentials, { role: 'internal' }); await new Promise(resolve => internal.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => internal.close(resolve)));
  assert.equal((await fetch(`http://127.0.0.1:${internal.address().port}${f.path}`, { headers: f.auth })).status, 404);
  assert.deepEqual(f.calls, []);
});

test('resume requires current exact approval, no activation hold, and a matching runtime generation', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('resume', { deployment: id, digest: 'b'.repeat(64) })).status, 400);
  f.c.state.apps.imports.delivery.hold = id;
  assert.equal((await f.post('resume', { deployment: id, digest })).status, 400);
  assert.deepEqual(f.calls, []);
  f.c.state.apps.imports.delivery.hold = null;
  await f.post('pause'); f.stale();
  const before = f.calls.length;
  const rejected = await f.post('resume', { deployment: id, digest });
  assert.equal(rejected.status, 502); assert.match((await rejected.json()).error, /could not be confirmed/);
  assert.deepEqual(f.calls.slice(before), ['info']); assert.equal(f.paused(), true);
  assert.equal(f.c.state.apps.imports.delivery.observed, 'unknown');
});

test('lost resume response preserves uncertainty, observe does not release it, and pause reconciles intent', async t => {
  const f = await fixture(t); await f.post('pause'); f.fail('resume');
  const response = await f.post('resume', { deployment: id, digest });
  assert.equal(response.status, 502); assert.equal((await response.text()).includes('private-runtime-diagnostic'), false);
  assert.equal(f.paused(), false);
  let state = f.c.state.apps.imports.delivery;
  assert.equal(state.operation, 'resume'); assert.equal(state.observed, 'unknown');
  const observed = await (await f.post('observe')).json();
  assert.equal(observed.observed, 'running'); assert.equal(observed.operation, 'resume');
  f.c.state.apps.imports.deliveryRecoveryError = 'previous failure';
  await f.post('pause'); state = f.c.state.apps.imports.delivery;
  assert.equal(f.c.state.apps.imports.deliveryRecoveryError, undefined);
  assert.equal(state.operation, null); assert.equal(state.desired, 'paused'); assert.equal(f.paused(), true);
});

test('metadata failure prevents delivery effects and authenticated reads report unavailable', async t => {
  const f = await fixture(t); f.diskFail();
  assert.equal((await f.post('pause')).status, 503);
  assert.deepEqual(f.calls, []);
  assert.equal((await fetch(f.origin + f.path, { headers: f.auth })).status, 503);
});

test('queued operator actions recheck activation state under the controller lock', async t => {
  const f = await fixture(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const changing = f.c.exclusive(async () => { await gate; f.c.state.apps.imports.delivery.hold = id; });
  let queued; const entered = new Promise(resolve => { queued = resolve; });
  const exclusive = f.c.exclusive.bind(f.c);
  f.c.exclusive = task => { const result = exclusive(task); queued(); return result; };
  const response = f.post('resume', { deployment: id, digest });
  let timer;
  try {
    await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Request did not enter the controller lock')), 5000); })]);
    assert.deepEqual(f.calls, []);
  } finally { clearTimeout(timer); release(); }
  await changing;
  assert.equal((await response).status, 400); assert.deepEqual(f.calls, []);
});


test('unavailable queue fleets expose recorded status without offering runtime controls', async t => {
  for (const state of ['quarantined', 'retired', 'bootstrap']) {
    await t.test(state, async t => {
      const f = await fixture(t), app = f.c.state.apps.imports;
      if (state === 'quarantined') app.quarantined = true;
      if (state === 'retired') app.retirement = {};
      if (state === 'bootstrap') app.queueBootstrap.phase = 'pending';
      const view = await (await fetch(f.origin + f.path, { headers: f.auth })).json();
      assert.equal(view.operationAllowed, false); assert.equal(view.resumeAllowed, false);
      const page = await (await fetch(f.origin + '/', { headers: f.auth })).text();
      assert.equal(page.includes('data-delivery="pause"'), false);
      assert.equal((await f.post('pause')).status, 400);
      assert.deepEqual(f.calls, []);
    });
  }
});

test('snapshot and recovery acknowledgment require admin CSRF, exact identities, and explicit CLI loss acceptance', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('snapshot', { deployment: id, digest }, { 'X-Fogd-CSRF': 'wrong' })).status, 403);
  assert.equal((await f.post('snapshot', { deployment: id, digest }, { authorization: 'Bearer deploy' })).status, 401);
  assert.equal((await f.post('snapshot', { deployment: id, digest })).status, 200);
  const app = f.c.state.apps.imports;
  app.queueRecovery = { id: randomUUID(), status: 'pending', snapshot: 'a'.repeat(64), prepared: app.queueSnapshot };
  delete app.queueSnapshot; app.route = 'paused'; f.c.state.requirements.push(queueRecoveryCapability); await f.c.save(); await recoverQueueSnapshots(f.c);
  const body = { deployment: id, digest, recovery: app.queueRecovery.id, review: recoveryReview(app.queueRecovery), acceptPossibleLoss: true };
  assert.equal((await f.post('acknowledge-recovery', body, { 'X-Fogd-CSRF': 'wrong' })).status, 403);
  assert.equal((await f.post('acknowledge-recovery', { ...body, recovery: randomUUID() })).status, 400);
  for (const path of ['/v1/admin', f.path, '/']) {
    const text = await (await fetch(f.origin + path, { headers: f.auth })).text();
    assert.ok(!text.includes(version)); assert.ok(!text.includes('"prepared"'));
    if (path === '/') assert.match(text, /Acknowledge recovery/);
  }
  const cli = (...args) => execute(process.execPath, [fileURLToPath(new URL('../../cli/bin/fogd.js', import.meta.url)), 'admin', 'recover', 'imports', id, digest, app.queueRecovery.id, recoveryReview(app.queueRecovery), ...args], { env: { ...process.env, FOGD_ENV_FILE: join(f.c.dir, 'absent.env'), FOGD_SERVER: f.origin, FOGD_ADMIN_USER: 'admin', FOGD_ADMIN_PASSWORD: 'password' } });
  await assert.rejects(cli(), /Usage/);
  const result = JSON.parse((await cli('--accept-possible-loss')).stdout);
  assert.equal(result.recovery.status, 'acknowledged'); assert.equal(result.desired, 'paused');
  assert.equal(f.paused(), true);
});
