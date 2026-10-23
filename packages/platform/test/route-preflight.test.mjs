import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { routeController } from './fixtures/route-controller.mjs';
import { writeRouteRecord, routeRecordDigest } from '../src/route-record-store.mjs';

const challenge = 'd'.repeat(64), input = { challenge };
const refused = { code: 'ROUTE_PREFLIGHT_UNCONFIRMED', message: 'HTTP routing preflight is unconfirmed; keep ingress stopped' };
async function settleFixture(f, record) {
  await writeRouteRecord(f.path, record, f.policy);
  f.c.state.routeAuthority.settled = { revision: record.revision, digest: routeRecordDigest(record, f.policy) }; await f.c.save();
}
async function active(t) {
  const f = await routeController(t), alpha = await f.request(), beta = await f.request('beta');
  await f.c.mutate(alpha.id, alpha.digest, 'approve'); await f.c.mutate(beta.id, beta.digest, 'approve');
  return { ...f, alpha, beta };
}
test('preflight observes both active fleets and returns only public authority with the supplied challenge', async t => {
  const f = await active(t), beforePrivate = await readFile(f.statePath), beforePublic = await readFile(f.path), effects = [...f.events];
  const observed = [], original = f.c.routes.options.verifyRuntime;
  f.c.routes.options.verifyRuntime = (name, selected) => { observed.push([name, structuredClone(selected)]); return original(name, selected); };
  const report = await f.c.preflightIngress(input);
  assert.deepEqual(observed, [['alpha', { id: f.alpha.id, digest: f.alpha.digest }], ['beta', { id: f.beta.id, digest: f.beta.digest }]]);
  assert.deepEqual(report, { schema: 1, challenge, authority: { record: JSON.parse(beforePublic), sha256: createHash('sha256').update(beforePublic).digest('hex') }, observedActiveHosts: ['alpha.localhost', 'beta.localhost'] });
  assert.equal(f.verifications(), 2); assert.deepEqual(f.events, effects);
  assert.deepEqual(await readFile(f.statePath), beforePrivate); assert.deepEqual(await readFile(f.path), beforePublic);
  assert.equal(JSON.stringify(report).includes(f.alpha.version), false);
});
test('withheld apps grant no permission and do not require runtime availability for peer preflight', async t => {
  const f = await active(t); await f.c.decideRoute('alpha', 'pause', { deployment: f.alpha.id, digest: f.alpha.digest });
  f.owners['slot-1'] = null;
  const report = await f.c.preflightIngress(input);
  assert.deepEqual(report.observedActiveHosts, ['beta.localhost']); assert.equal(f.verifications(), 1);
  assert.equal(report.authority.record.routes[0].state, 'withheld');
});
test('empty authority observes no active hosts and performs no native verification', async t => {
  const f = await routeController(t), report = await f.c.preflightIngress(input);
  assert.equal(report.authority.record.revision, '0'); assert.deepEqual(report.observedActiveHosts, []); assert.equal(f.verifications(), 0);
});
for (const value of [null, {}, [], { challenge: 'bad' }, { challenge: challenge.toUpperCase() }, { challenge, extra: true }, Object.assign(Object.create({ challenge }), { other: true })]) test('preflight requires a complete, exact challenge request before observing authority', async t => {
  const f = await routeController(t); await assert.rejects(f.c.preflightIngress(value), /exactly one 64-character hexadecimal challenge/);
  assert.equal(f.verifications(), 0); assert.deepEqual(f.events, []);
});
test('unresolved pending publication refuses preflight without verifying a runtime or changing authority', async t => {
  const f = await routeController(t), release = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(release.id, release.digest, 'approve'), /uncertain/); f.failPublic(null);
  const controller = f.create(); await controller.init(); const before = await readFile(f.path);
  await assert.rejects(controller.preflightIngress(input), refused);
  assert.equal(f.verifications(), 0); assert.deepEqual(await readFile(f.path), before);
});
test('a runtime failure refuses the whole report and does not disclose its private error', async t => {
  const f = await active(t); f.c.routes.options.verifyRuntime = async () => { throw new Error('PRIVATE runtime details'); };
  const before = await readFile(f.path); await assert.rejects(f.c.preflightIngress(input), refused);
  assert.deepEqual(await readFile(f.path), before);
});
for (const field of ['version', 'secretRevision']) test(`approval ${field} changed during a later fleet check invalidates the whole report`, async t => {
  const f = await active(t), original = f.c.routes.options.verifyRuntime;
  f.c.routes.options.verifyRuntime = async (...args) => {
    await original(...args);
    if (args[0] === 'beta') f.c.state.deployments[f.alpha.id][field] = field === 'version' ? 'changed-native-version' : '00000000-0000-4000-8000-000000000002';
  };
  await assert.rejects(f.c.preflightIngress(input), refused);
});
test('a new background hold during observation invalidates the report', async t => {
  const f = await active(t), original = f.c.routes.options.verifyRuntime;
  f.c.routes.options.verifyRuntime = async (...args) => { await original(...args); if (args[0] === 'beta') f.c.state.apps.alpha.queueRecovery = { status: 'pending' }; };
  await assert.rejects(f.c.preflightIngress(input), refused);
});
test('public authority replacement during observation refuses and latches publication uncertainty', async t => {
  const f = await active(t), original = f.c.routes.options.verifyRuntime;
  f.c.routes.options.verifyRuntime = async (...args) => { await original(...args); if (args[0] === 'beta') { const record = await f.public(); record.revision = String(BigInt(record.revision) + 1n); await writeRouteRecord(f.path, record, f.policy); } };
  await assert.rejects(f.c.preflightIngress(input), refused);
  await assert.rejects(f.c.routes.checkReady(), { code: 'ROUTE_PUBLICATION_UNCERTAIN' });
});
test('a privately serving app omitted from settled public authority cannot pass as an empty installation', async t => {
  const f = await active(t), record = { ...(await f.public()), routes: [] };
  await settleFixture(f, record);
  await assert.rejects(f.c.preflightIngress(input), refused); assert.equal(f.verifications(), 0);
});
test('a public active route cannot bypass a private HTTP approval hold', async t => {
  const f = await active(t); f.c.state.routeAuthority.holds.alpha = { id: f.alpha.id, digest: f.alpha.digest };
  await f.c.save(); await assert.rejects(f.c.preflightIngress(input), refused); assert.equal(f.verifications(), 0);
});
test('controller mutation waits for the read-only observation and can change authority afterward', async t => {
  const f = await active(t), original = f.c.routes.options.verifyRuntime; let started, release;
  const reading = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.c.routes.options.verifyRuntime = async (...args) => { if (args[0] === 'alpha') { started(); await gate; } await original(...args); };
  const preflight = f.c.preflightIngress(input); await reading;
  const pause = f.c.decideRoute('alpha', 'pause', { deployment: f.alpha.id, digest: f.alpha.digest });
  assert.equal((await f.public()).routes[0].state, 'active'); release();
  const report = await preflight; await pause;
  assert.equal(report.authority.record.routes[0].state, 'active'); assert.equal((await f.public()).routes[0].state, 'withheld');
});

for (const [name, change] of [
  ['cross-fleet permission swap', record => { [record.routes[0].slot, record.routes[1].slot] = [record.routes[1].slot, record.routes[0].slot]; }],
  ['another app approval', record => { record.routes[0].submission = record.routes[1].submission; record.routes[0].digest = record.routes[1].digest; }],
  ['foreign host', record => { record.routes[0].host = 'foreign.localhost'; record.routes.sort((a, b) => a.host < b.host ? -1 : 1); }],
  ['withheld public permission without a private hold', record => { const { host, slot } = record.routes[0]; record.routes[0] = { host, slot, state: 'withheld' }; }],
]) test(`semantically mismatched settled stores refuse despite matching byte references: ${name}`, async t => {
  const f = await active(t), record = await f.public(); change(record);
  await settleFixture(f, record);
  await assert.rejects(f.c.preflightIngress(input), refused); assert.equal(f.verifications(), 0);
});

test('a valid constructor app can activate, recover holds, pause and resume without inherited HTTP holds', async t => {
  const f = await routeController(t), release = await f.request('constructor');
  await f.c.mutate(release.id, release.digest, 'approve');
  assert.deepEqual((await f.c.preflightIngress(input)).observedActiveHosts, ['constructor.localhost']);
  const failed = await f.request('constructor'); f.fail('publish'); await f.c.mutate(failed.id, failed.digest, 'approve');
  assert.equal((await f.c.routes.view('constructor')).hold.id, failed.id);
  const corrected = await f.request('constructor');
  await f.c.mutate(corrected.id, corrected.digest, 'approve', undefined, { deployment: failed.id, digest: failed.digest });
  assert.equal((await f.c.routes.view('constructor')).hold, null);
  const controller = f.create(); await controller.init();
  await controller.decideRoute('constructor', 'pause', { deployment: corrected.id, digest: corrected.digest });
  assert.equal((await controller.routes.view('constructor')).hold, null);
  await controller.decideRoute('constructor', 'resume', { deployment: corrected.id, digest: corrected.digest });
  assert.deepEqual((await controller.preflightIngress(input)).observedActiveHosts, ['constructor.localhost']);
  assert.equal((await controller.routes.view('constructor')).hold, null);
});

test('preflight report excludes an actual pinned secret revision and native version', async t => {
  const f = await active(t), secretRevision = '00000000-0000-4000-8000-000000000099';
  f.c.state.deployments[f.alpha.id].secretRevision = secretRevision; f.c.state.apps.alpha.privateConfiguration = true; await f.c.save();
  const report = await f.c.preflightIngress(input), text = JSON.stringify(report);
  assert.equal(text.includes(secretRevision), false); assert.equal(text.includes(f.alpha.version), false);
  assert.deepEqual(Object.keys(report).sort(), ['authority', 'challenge', 'observedActiveHosts', 'schema']);
});

test('resettling identical public bytes is a positive control for semantic mismatch fixtures', async t => {
  const f = await active(t); await settleFixture(f, await f.public());
  const report = await f.c.preflightIngress(input);
  assert.deepEqual(report.observedActiveHosts, ['alpha.localhost', 'beta.localhost']); assert.equal(f.verifications(), 2);
});
test('a consistently changed settled revision during native observations still invalidates the report', async t => {
  const f = await active(t), original = f.c.routes.options.verifyRuntime;
  f.c.routes.options.verifyRuntime = async (...args) => {
    await original(...args);
    if (args[0] === 'beta') { const record = await f.public(); record.revision = String(BigInt(record.revision) + 1n); await settleFixture(f, record); }
  };
  await assert.rejects(f.c.preflightIngress(input), refused);
});
test('an independently latched private storage failure during observation prevents a report', async t => {
  const f = await active(t), original = f.c.routes.options.verifyRuntime;
  f.c.routes.options.verifyRuntime = async (...args) => {
    await original(...args);
    if (args[0] === 'beta') {
      f.failPrivate(file => file.endsWith('/state.json') ? 'before' : null);
      await assert.rejects(f.c.save(), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    }
  };
  await assert.rejects(f.c.preflightIngress(input), refused);
});
