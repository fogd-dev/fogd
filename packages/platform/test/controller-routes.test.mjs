import test from 'node:test';
import assert from 'node:assert/strict';
import { routeController } from './fixtures/route-controller.mjs';

test('controller initializes empty authority and withholds before every activation effect', async t => {
  const f = await routeController(t);
  assert.deepEqual((await f.public()).routes, []);
  const request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
  assert.equal(request.status, 'active');
  assert.deepEqual((await f.public()).routes, [{ host: 'alpha.localhost', state: 'active', slot: 'slot-1', submission: request.id, digest: request.digest }]);
  assert.deepEqual(f.events.map(event => event.kind), ['claim', 'publish', 'ready', 'ledger', 'migrate', 'ledger']);
});
test('uncertain withholding stops the controller before its first backend effect', async t => {
  const f = await routeController(t), request = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'withheld' ? 'before' : null);
  await assert.rejects(f.c.mutate(request.id, request.digest, 'approve'), /uncertain/);
  assert.deepEqual(f.events, []);
  assert.equal((await f.private()).routeAuthority.pending.kind, 'withhold');
  await assert.rejects(f.c.issueCredential('later', ['alpha']), /uncertain/);
});
test('active-publication uncertainty preserves the durable completion for explicit reconciliation', async t => {
  const f = await routeController(t), request = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(request.id, request.digest, 'approve'), /uncertain/);
  const state = await f.private();
  assert.equal(state.deployments[request.id].status, 'active'); assert.equal(state.deployments[request.id].step, 'complete');
  assert.equal(state.routeAuthority.pending.kind, 'active');
  assert.equal((await f.public()).routes[0].submission, request.id);
});

test('restart leaves pending active publication for an explicit read-only reconciliation', async t => {
  const f = await routeController(t), request = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(request.id, request.digest, 'approve'), /uncertain/);
  const events = [...f.events]; f.failPublic(null);
  const restored = f.create(); await restored.init();
  assert.deepEqual(f.events, events); assert.equal(f.verifications(), 0);
  const pending = (await f.private()).routeAuthority.pending;
  await restored.decideRoute('alpha', 'reconcile', { intent: pending.id, deployment: request.id, digest: request.digest });
  assert.deepEqual(f.events, events); assert.equal(f.verifications(), 1);
  assert.equal((await f.private()).routeAuthority.pending, null);
  assert.equal((await f.public()).routes[0].submission, request.id);
});
test('corrected HTTP approval explicitly replaces the failed hold and never revives its predecessor', async t => {
  const f = await routeController(t), first = await f.request(); await f.c.mutate(first.id, first.digest, 'approve');
  const second = await f.request(); f.fail('publish'); await f.c.mutate(second.id, second.digest, 'approve');
  assert.equal(second.status, 'failed'); assert.equal((await f.public()).routes[0].state, 'withheld');
  await assert.rejects(f.c.decideRoute('alpha', 'resume', { deployment: first.id, digest: first.digest }), /different approval/);
  const third = await f.request(); await assert.rejects(f.c.mutate(third.id, third.digest, 'approve'), /held HTTP approval/);
  await f.c.mutate(third.id, third.digest, 'approve', undefined, { deployment: second.id, digest: second.digest });
  assert.equal(third.status, 'active'); assert.equal((await f.public()).routes[0].submission, third.id);
});
test('rejected pristine claim removes its route before the next app reuses that fleet', async t => {
  const f = await routeController(t), first = await f.request(); f.fail('claim');
  await assert.rejects(f.c.mutate(first.id, first.digest, 'approve'), /Failed claim/);
  assert.equal((await f.public()).routes[0].state, 'withheld');
  await f.c.mutate(first.id, first.digest, 'reject');
  assert.deepEqual((await f.public()).routes, []); assert.deepEqual((await f.private()).routeAuthority.holds, {});
  const second = await f.request('beta'); await f.c.mutate(second.id, second.digest, 'approve');
  assert.deepEqual((await f.public()).routes, [{ host: 'beta.localhost', state: 'active', slot: 'slot-1', submission: second.id, digest: second.digest }]);
});
test('operator pause and verified resume preserve the completed approval', async t => {
  const f = await routeController(t), request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
  const input = { deployment: request.id, digest: request.digest };
  const paused = await f.c.decideRoute('alpha', 'pause', input); assert.equal(paused.state, 'withheld');
  const events = [...f.events]; const resumed = await f.c.decideRoute('alpha', 'resume', input);
  assert.equal(resumed.state, 'active'); assert.deepEqual(f.events, events); assert.equal(f.verifications(), 1);
});

for (const when of ['before', 'after']) test(`claim removal resumes after ${when}-public uncertainty without releasing another app's slot`, async t => {
  const f = await routeController(t), first = await f.request(); f.fail('claim');
  await assert.rejects(f.c.mutate(first.id, first.digest, 'approve'), /Failed claim/);
  let armed = true; f.failPublic(record => { if (armed && record.routes.length === 0) { armed = false; return when; } });
  await assert.rejects(f.c.mutate(first.id, first.digest, 'reject'), /uncertain/);
  const restored = f.create(); await restored.init();
  assert.deepEqual((await f.public()).routes, []); assert.ok(restored.state.apps.alpha.claim);
  await restored.mutate(first.id, first.digest, 'reject');
  const next = await f.request('beta', restored); await restored.mutate(next.id, next.digest, 'approve');
  assert.equal((await f.public()).routes[0].host, 'beta.localhost');
});
test('startup publishes quarantine before permitting any later backend change', async t => {
  const f = await routeController(t), request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
  f.owners['slot-1'] = null; const before = [...f.events];
  const restored = f.create(); await restored.init();
  assert.equal(restored.state.apps.alpha.quarantined, true); assert.equal((await f.public()).routes[0].state, 'withheld');
  assert.deepEqual(f.events, before);
  await assert.rejects(restored.decideRoute('alpha', 'resume', { deployment: request.id, digest: request.digest }), /withhold/);
});
test('startup completes an unfinished withhold but never retries the failed activation automatically', async t => {
  const f = await routeController(t), request = await f.request(); let armed = true;
  f.failPublic(() => { if (armed) { armed = false; return 'before'; } });
  await assert.rejects(f.c.mutate(request.id, request.digest, 'approve'), /uncertain/);
  const restored = f.create(); await restored.init();
  assert.deepEqual(f.events, []); assert.equal(restored.state.deployments[request.id].status, 'failed');
  assert.equal((await f.public()).routes[0].state, 'withheld'); assert.equal(restored.state.routeAuthority.pending, null);
});

test('a pending active record with lost private approval is withheld before startup refuses', async t => {
  const f = await routeController(t), request = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(request.id, request.digest, 'approve'), /uncertain/);
  const saved = await f.private(); saved.deployments[request.id].status = 'failed';
  const { saveJson } = await import('../src/store.mjs'); await saveJson(f.statePath, saved);
  const before = [...f.events], restored = f.create();
  await assert.rejects(restored.init(), { code: 'ROUTE_STARTUP_UNRECONCILED' }); assert.deepEqual(f.events, before);
  assert.equal((await f.public()).routes[0].state, 'withheld');
});

test('explicit fresh enrollment cannot repair retained null private state', async t => {
  const f = await routeController(t), { writeFile, readFile, rm } = await import('node:fs/promises');
  await writeFile(f.statePath, 'null'); await rm(f.path);
  const restored = f.create(); await assert.rejects(restored.init());
  await assert.rejects(readFile(f.path), { code: 'ENOENT' });
  assert.equal(await readFile(f.statePath, 'utf8'), 'null');
});

test('a default controller still refuses authority state before any backend effect', async t => {
  const f = await routeController(t), before = [...f.events], legacy = f.create({ routeAuthority: null });
  await assert.rejects(legacy.init(), /unsupported platform capability/);
  assert.deepEqual(f.events, before);
});
test('retained empty state cannot silently enroll into durable routing', async t => {
  const f = await routeController(t), { writeFile, readFile, rm } = await import('node:fs/promises');
  const prior = JSON.stringify({ apps: {}, deployments: {} }); await writeFile(f.statePath, prior); await rm(f.path);
  const restored = f.create(); await assert.rejects(restored.init(), /explicitly fresh private storage/);
  assert.equal(await readFile(f.statePath, 'utf8'), prior); await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});
test('constructor refuses public authority inside private storage and implicit lookup fallback', async t => {
  const f = await routeController(t);
  assert.throws(() => f.create({ routeAuthority: { ...f.routeAuthority, path: f.dir + '/routes.json' } }), /outside private controller storage/);
  assert.throws(() => f.create({ routeAuthority: false }), /Invalid durable routing configuration/);
  assert.throws(() => f.create({ routeAuthority: { ...f.routeAuthority, verifyRuntime: undefined } }), /read-only runtime verification/);
  assert.deepEqual(f.events, []);
});

test('a pending peer prevents a false healthy startup and explicit reconciliation completes quarantine', async t => {
  const f = await routeController(t), alpha = await f.request(), beta = await f.request('beta');
  await f.c.mutate(alpha.id, alpha.digest, 'approve'); await f.c.mutate(beta.id, beta.digest, 'approve');
  const update = await f.request(); f.failPublic(record => record.routes.find(route => route.host === 'alpha.localhost')?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(update.id, update.digest, 'approve'), /uncertain/);
  f.failPublic(null); f.owners['slot-2'] = null;
  const restored = f.create(); await assert.rejects(restored.init(), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  assert.equal((await restored.routes.view('beta')).startupBlocked, true);
  assert.equal((await f.public()).routes.find(route => route.host === 'beta.localhost').state, 'active');
  const pending = restored.state.routeAuthority.pending;
  await restored.decideRoute('alpha', 'reconcile', { intent: pending.id, deployment: update.id, digest: update.digest });
  assert.equal((await f.public()).routes.find(route => route.host === 'beta.localhost').state, 'withheld');
  assert.equal((await restored.routes.view('alpha')).startupBlocked, false);
});
test('mismatched slot metadata withholds public permission before refusing startup', async t => {
  const f = await routeController(t), request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
  f.c.state.apps.alpha.slot = 'slot-2'; await f.c.save();
  const restored = f.create(); await assert.rejects(restored.init(), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  assert.deepEqual((await f.public()).routes, [{ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1' }]);
  assert.equal(restored.state.apps.alpha.slot, 'slot-2');
  const again = f.create(); await assert.rejects(again.init(), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  assert.equal((await f.public()).routes[0].state, 'withheld');
});
test('public authority directory cannot contain private controller storage', async t => {
  const f = await routeController(t);
  assert.throws(() => f.create({ routeAuthority: { ...f.routeAuthority, path: f.root + '/routes.json' } }), /outside private controller storage/);
  assert.deepEqual(f.events, []);
});

test('a rejected publication validation cannot leave a phantom activation for later saves', async t => {
  const f = await routeController(t), domain = ['x'.repeat(63), 'y'.repeat(63), 'z'.repeat(63)].join('.');
  const c = f.create({ baseDomain: domain }); await c.init();
  const request = await f.request('a'.repeat(63), c);
  await assert.rejects(c.mutate(request.id, request.digest, 'approve'), /Invalid route authority record/);
  assert.equal(request.status, 'pending'); assert.equal(c.state.apps[request.app], undefined);
  await c.save(); assert.equal((await f.private()).deployments[request.id].status, 'pending');
  assert.deepEqual((await f.public()).routes, []);
});

for (const when of ['before', 'after']) test(`startup quarantine finishes permission reduction after ${when}-public failure`, async t => {
  const f = await routeController(t), request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
  f.c.state.apps.alpha.slot = 'slot-2'; await f.c.save(); let armed = true;
  f.failPublic(record => { if (armed && record.routes[0]?.state === 'withheld') { armed = false; return when; } });
  const initial = f.create(); await assert.rejects(initial.init(), /uncertain/);
  assert.equal((await f.private()).routeAuthority.pending.kind, 'quarantine');
  const restored = f.create(); await assert.rejects(restored.init(), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  assert.equal((await f.public()).routes[0].state, 'withheld'); assert.equal((await f.private()).routeAuthority.pending, null);
});

test('invalid peer approval cannot make startup withdraw an otherwise valid pending active route', async t => {
  const f = await routeController(t), alpha = await f.request(), beta = await f.request('beta');
  await f.c.mutate(alpha.id, alpha.digest, 'approve'); await f.c.mutate(beta.id, beta.digest, 'approve');
  const update = await f.request(); f.failPublic(record => record.routes.find(route => route.host === 'alpha.localhost')?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(update.id, update.digest, 'approve'), /uncertain/); f.failPublic(null);
  const state = await f.private(); state.deployments[beta.id].status = 'failed';
  const { saveJson } = await import('../src/store.mjs'); await saveJson(f.statePath, state);
  const restored = f.create(); await assert.rejects(restored.init(), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  assert.equal((await f.public()).routes.find(route => route.host === 'alpha.localhost').state, 'active');
  assert.equal(restored.state.routeAuthority.pending.id, state.routeAuthority.pending.id);
});

test('failed ownership inspection permits reduction but cannot be bypassed by pause or resume', async t => {
  const f = await routeController(t), request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
  const original = f.backend.owner; f.backend.owner = async () => { throw new Error('Ownership unavailable'); };
  const restored = f.create(); await assert.rejects(restored.init(), /Ownership unavailable/);
  const events = [...f.events], input = { deployment: request.id, digest: request.digest };
  await restored.decideRoute('alpha', 'pause', input);
  assert.equal(restored.routingStartupComplete, false); assert.equal((await restored.routes.view('alpha')).startupBlocked, true);
  await assert.rejects(restored.routes.checkReady(), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  await assert.rejects(restored.decideRoute('alpha', 'resume', input), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  assert.equal(f.verifications(), 0); assert.deepEqual(f.events, events); assert.equal((await f.public()).routes[0].state, 'withheld');
  f.backend.owner = original; const healthy = f.create(); await healthy.init();
  await healthy.decideRoute('alpha', 'resume', input); assert.equal((await f.public()).routes[0].submission, request.id);
});
test('pending publication with a restored slot mismatch is withdrawn using its public slot', async t => {
  const f = await routeController(t), request = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(request.id, request.digest, 'approve'), /uncertain/); f.failPublic(null);
  const state = await f.private(); state.apps.alpha.slot = 'slot-2';
  const { saveJson } = await import('../src/store.mjs'); await saveJson(f.statePath, state);
  const restored = f.create(); await assert.rejects(restored.init(), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  assert.deepEqual((await f.public()).routes, [{ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1' }]);
  assert.equal(restored.state.apps.alpha.slot, 'slot-2'); assert.equal(restored.routingStartupComplete, false);
  await assert.rejects(restored.routes.checkReady(), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  await assert.rejects(restored.decideRoute('alpha', 'resume', { deployment: request.id, digest: request.digest }), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  assert.equal(f.verifications(), 0);
});
test('startup quarantine of a pending app reduces permission without adopting another owner', async t => {
  const f = await routeController(t), request = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(request.id, request.digest, 'approve'), /uncertain/); f.failPublic(null);
  f.owners['slot-2'] = { app: 'alpha' }; const restored = f.create(); await restored.init();
  assert.equal(restored.state.apps.alpha.quarantined, true); assert.equal(restored.state.apps.alpha.slot, 'slot-1');
  assert.equal((await f.public()).routes[0].state, 'withheld'); assert.equal(restored.state.routeAuthority.pending, null);
});

test('storage separation also refuses a public directory alias containing private metadata', async t => {
  const f = await routeController(t), { mkdir, symlink, readFile } = await import('node:fs/promises');
  await mkdir(f.root + '/shared', { mode: 0o755 });
  await symlink(f.root, f.root + '-alias'); t.after(() => import('node:fs/promises').then(fs => fs.unlink(f.root + '-alias')));
  const bad = f.create({ dir: f.root + '/shared/private', routeAuthority: { ...f.routeAuthority, path: f.root + '-alias/shared/routes.json' } });
  await assert.rejects(bad.init(), /outside private controller storage/);
  await assert.rejects(readFile(f.root + '/shared/routes.json'), { code: 'ENOENT' });
});

test('pending active route comparison accepts reordered private JSON keys without withdrawing permission', async t => {
  const f = await routeController(t), request = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(request.id, request.digest, 'approve'), /uncertain/); f.failPublic(null);
  const saved = await f.private();
  saved.routeAuthority.pending.record.routes = saved.routeAuthority.pending.record.routes.map(route => Object.fromEntries(Object.entries(route).reverse()));
  const { writeFile } = await import('node:fs/promises'); await writeFile(f.statePath, JSON.stringify(saved));
  const before = await f.public(), effects = [...f.events], controller = f.create(); await controller.init();
  assert.deepEqual(await f.public(), before); assert.deepEqual(f.events, effects);
  assert.equal(controller.state.routeAuthority.pending.kind, 'active'); assert.equal(f.verifications(), 0);
});
