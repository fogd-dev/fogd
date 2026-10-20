import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fixture as activationFixture } from './fixtures/cron-controller.mjs';
import { server } from '../src/http.mjs';
import { CronRuntime } from '../src/cron-runtime.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const f = await activationFixture(t);
  const selected = await f.c.replaceSecrets('refresh', { REFRESH_TOKEN: 'private-refresh-value' });
  const active = await f.request(f.c, { requiredSecrets: ['REFRESH_TOKEN'] });
  await f.c.mutate(active.id, active.digest, 'approve', selected.revision); assert.equal(active.status, 'active');
  const credentials = { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' };
  const http = server(f.c, credentials); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const origin = `http://127.0.0.1:${http.address().port}`, path = '/v1/apps/refresh/dispatch';
  const auth = { Authorization: `Basic ${Buffer.from('admin:password').toString('base64')}` };
  const admin = await (await fetch(origin + '/v1/admin', { headers: auth })).json();
  const post = (action, body = {}, headers = {}) => fetch(origin + path + '/' + action, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': admin.csrf, ...headers }, body: JSON.stringify(body) });
  const status = async () => (await fetch(origin + path, { headers: auth })).json();
  const cli = args => execute(process.execPath, [fileURLToPath(new URL('../../cli/bin/fogd.js', import.meta.url)), 'admin', 'dispatch', 'refresh', ...args], {
    env: { ...process.env, FOGD_ENV_FILE: join(f.dir, 'absent.env'), FOGD_SERVER: origin, FOGD_ADMIN_USER: 'admin', FOGD_ADMIN_PASSWORD: 'password' }, timeout: 15000,
  });
  return { ...f, active, credentials, origin, path, auth, post, status, cli };
}

test('recorded dispatch API, page and CLI status have no runtime effects or private version output', async t => {
  const f = await fixture(t), before = await readFile(join(f.dir, 'state.json'), 'utf8'), events = (await f.runtime()).events;
  for (const path of [f.path, '/v1/admin', '/']) {
    const response = await fetch(f.origin + path, { headers: f.auth }); assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const text = await response.text(); assert.ok(!text.includes(f.active.version)); assert.ok(!text.includes('private-refresh-value'));
    if (path === '/') { assert.match(text, /Scheduled dispatch/); assert.match(text, /Pause does not drain/); assert.match(text, /Check the application/); }
  }
  const state = JSON.parse((await f.cli([])).stdout);
  assert.equal(state.desired, 'running'); assert.equal(state.applicationOutcomes, 'not-observed');
  assert.deepEqual(state.active, { deployment: f.active.id, digest: f.active.digest });
  assert.equal(state.approval.status, 'active'); assert.equal(state.approval.step, 'complete');
  assert.deepEqual((await f.runtime()).events, events); assert.equal(await readFile(join(f.dir, 'state.json'), 'utf8'), before);
  assert.equal(JSON.parse((await f.cli(['pause'])).stdout).observed, 'paused');
  assert.equal((await f.runtime()).paused, true); assert.equal(f.c.route('refresh.localhost').state, 'active');
  await assert.rejects(f.cli(['resume']), /requires/);
  await assert.rejects(f.cli(['resume', f.active.id, f.active.digest, 'extra']), /Too many/);
  const resumed = JSON.parse((await f.cli(['resume', f.active.id, f.active.digest])).stdout);
  assert.equal(resumed.observed, 'running'); assert.equal((await f.runtime()).paused, false);
  assert.ok(!JSON.stringify(resumed).includes(f.active.version));
});

test('dispatch operations require admin auth and CSRF, reject foreign origins and stay off internal listener', async t => {
  const f = await fixture(t), before = (await f.runtime()).events.length;
  for (const Authorization of ['', 'Bearer deploy', 'Bearer gateway']) {
    assert.equal((await fetch(f.origin + f.path, { headers: { Authorization } })).status, 401);
    assert.equal((await f.post('pause', {}, { Authorization })).status, 401);
  }
  assert.equal((await f.post('observe', {}, { 'X-Fogd-CSRF': '' })).status, 403);
  assert.equal((await f.post('pause', {}, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.post('pause', [])).status, 400);
  const internal = server(f.c, f.credentials, { role: 'internal' }); await new Promise(resolve => internal.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => internal.close(resolve)));
  assert.equal((await fetch(`http://127.0.0.1:${internal.address().port}${f.path}`, { headers: f.auth })).status, 404);
  assert.equal((await f.runtime()).events.length, before);
});

test('resume requires the current approved identity and refuses holds, uncertain migrations and incomplete bootstrap', async t => {
  const f = await fixture(t), app = f.c.state.apps.refresh, before = (await f.runtime()).events.length;
  assert.equal((await f.post('resume', { deployment: f.active.id, digest: 'b'.repeat(64) })).status, 400);
  for (const patch of [ { uncertain: f.active.id }, { quarantined: true }, { retirement: {} }, { cronBootstrap: { phase: 'pending' } }, { route: 'paused' } ]) {
    const saved = structuredClone(app); Object.assign(app, patch);
    assert.equal((await f.post('resume', { deployment: f.active.id, digest: f.active.digest })).status, 400);
    Object.keys(app).forEach(key => delete app[key]); Object.assign(app, saved);
  }
  assert.equal((await f.runtime()).events.length, before);
  const update = await f.request(); f.fail('publish'); await f.c.mutate(update.id, update.digest, 'approve', null);
  assert.equal(update.status, 'failed');
  const view = await f.status(); assert.equal(view.hold, update.id); assert.equal(view.approval.deployment, update.id);
  assert.equal(view.approval.status, 'failed'); assert.equal(view.resumeAllowed, false);
  assert.equal((await f.post('resume', { deployment: f.active.id, digest: f.active.digest })).status, 400);
  assert.equal((await f.post('observe')).status, 200); assert.equal(f.c.state.apps.refresh.dispatch.hold, update.id);
  const alternate = await f.request();
  const page = await (await fetch(f.origin + '/', { headers: f.auth })).text();
  assert.ok(page.includes(`data-id="${update.id}" data-digest="${update.digest}" data-action="approve"`));
  assert.ok(!page.includes(`data-id="${update.id}" data-digest="${update.digest}" data-action="reject"`));
  assert.ok(!page.includes(`data-id="${alternate.id}" data-digest="${alternate.digest}" data-action="approve"`));
  assert.ok(page.includes(`data-id="${alternate.id}" data-digest="${alternate.digest}" data-action="reject"`)); assert.match(page, /Wait for or retry that activation/);
  app.dispatchRecoveryError = 'Cron pause could not be confirmed; retry the held activation after restoring its fleet';
  const paused = await (await f.post('pause')).json();
  assert.equal(paused.hold, update.id); assert.equal(paused.desired, 'paused'); assert.equal(paused.recoveryError, null);
  await f.c.mutate(update.id, update.digest, 'approve', null); assert.equal(update.status, 'active');
  assert.equal(app.dispatch.hold, null); assert.equal(app.dispatch.desired, 'paused'); assert.equal((await f.runtime()).paused, true);
});

test('lost resume response is unknown, observation preserves the operation, and pause safely reconciles it', async t => {
  const f = await fixture(t); await f.post('pause'); f.fail('resume');
  const response = await f.post('resume', { deployment: f.active.id, digest: f.active.digest });
  assert.equal(response.status, 502); const text = await response.text(); assert.ok(!text.includes('Lost resume')); assert.ok(!text.includes(f.active.version));
  assert.equal((await f.runtime()).paused, false);
  let state = await f.status(); assert.equal(state.observed, 'unknown'); assert.equal(state.operation, 'resume');
  state = await (await f.post('observe')).json(); assert.equal(state.observed, 'running'); assert.equal(state.operation, 'resume');
  state = await (await f.post('pause')).json(); assert.equal(state.desired, 'paused'); assert.equal(state.observed, 'paused'); assert.equal(state.operation, null);
  assert.equal((await f.runtime()).paused, true);
});

test('unavailable runtime leaves pause unconfirmed without pretending HTTP routing is paused', async t => {
  const f = await fixture(t); f.fail('pause', 'before');
  assert.equal((await f.post('pause')).status, 502);
  assert.equal((await f.runtime()).paused, false);
  const state = await f.status(); assert.equal(state.desired, 'paused'); assert.equal(state.observed, 'unknown'); assert.equal(state.operation, 'pause');
  assert.equal(f.c.route('refresh.localhost').state, 'active');
  f.fail('pause', 'before'); assert.equal((await f.post('pause')).status, 502);
  assert.equal((await f.post('pause')).status, 200); assert.equal((await f.runtime()).paused, true);
});

test('stale runtime replica blocks release through the admin API and a fresh explicit retry can resume', async t => {
  const f = await fixture(t); await f.post('pause'); const model = f.backend.crons;
  const calls = []; let stale = true;
  f.backend.crons = new CronRuntime({
    async run(slot, args) {
      const verb = args[1]; calls.push(verb);
      if (verb === 'resume') await model.resume(slot, 'refresh', f.active.version);
      if (verb === 'pause') await model.pause(slot, 'refresh');
      return JSON.stringify({ paused: (await f.runtime()).paused, revision: 2, nextAlarm: null, crons: ['* * * * *'] });
    },
    async inspect(node) { return { version: stale && node === 'b' ? 'other-version' : f.active.version, generation: 1, cells: node === 'a' ? { '.cron:refresh': 1 } : {} }; },
  });
  assert.equal((await f.post('resume', { deployment: f.active.id, digest: f.active.digest })).status, 502);
  assert.deepEqual(calls, ['info']); assert.equal((await f.runtime()).paused, true);
  assert.equal((await f.status()).observed, 'unknown');
  stale = false;
  assert.equal((await f.post('resume', { deployment: f.active.id, digest: f.active.digest })).status, 200);
  assert.equal((await f.runtime()).paused, false);
});

test('metadata failure latches control-plane access before any runtime pause', async t => {
  const f = await fixture(t), before = (await f.runtime()).events.length;
  f.failWrite(state => state.apps?.refresh?.dispatch?.operation === 'pause' ? 'before' : null);
  assert.equal((await f.post('pause')).status, 503);
  assert.equal((await f.runtime()).events.length, before); assert.equal((await f.runtime()).paused, false);
  assert.equal((await fetch(f.origin + f.path, { headers: f.auth })).status, 503);
  assert.equal((await f.post('observe')).status, 503);
});


test('a queued resume rechecks the activation hold after acquiring the controller lock', async t => {
  const f = await fixture(t), events = (await f.runtime()).events;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const changing = f.c.exclusive(async () => { await gate; f.c.state.apps.refresh.dispatch.hold = f.active.id; });
  const queued = new Promise(resolve => { entered = resolve; });
  const exclusive = f.c.exclusive.bind(f.c);
  f.c.exclusive = task => { const result = exclusive(task); entered(); return result; };
  const response = f.post('resume', { deployment: f.active.id, digest: f.active.digest });
  let timer;
  try {
    await Promise.race([queued, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Request did not acquire the controller lock')), 5000); })]);
    assert.deepEqual((await f.runtime()).events, events);
  } finally { clearTimeout(timer); release(); }
  await changing;
  assert.equal((await response).status, 400); assert.deepEqual((await f.runtime()).events, events);
});
