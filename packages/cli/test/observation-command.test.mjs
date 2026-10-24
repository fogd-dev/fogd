import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { observationFixture } from './fixtures/observation-cli.mjs';
const networkObserver = row => row.args[0] === 'run' && row.args.some(value => value.startsWith('fogd.observer.id='));
const report = async (fixture, extra) => JSON.parse((await fixture.invoke(undefined, extra)).stdout);

test('copied CLI observes only its selected fleet with no networked data mounts or arbitrary output', async t => {
  const f = await observationFixture(t), canonical = join(f.root, '.fogd/installations', f.project, 'compose.json'), before = await readFile(canonical);
  const output = await report(f); assert.equal(output.nativeReadiness, 'confirmed'); assert.equal(output.controllerProcess, 'running-at-boundaries');
  assert.equal(output.applicationOutcomes, 'not-observed'); assert.equal(output.controllerStorageHealth, 'not-observed');
  assert.equal(JSON.stringify(output).includes('private-'), false); assert.deepEqual(await readFile(canonical), before);
  const calls = await f.calls(), workers = calls.filter(networkObserver); assert.equal(workers.length, 1);
  const { args, input } = workers[0], payload = JSON.parse(input);
  assert.equal(args[args.indexOf('--network') + 1], f.plan.config.networks['fleet-1'].name);
  const dockerArgs = args.slice(0, args.indexOf(f.plan.config.services.controller.image));
  for (const forbidden of ['--mount', '--volume', '-v', '--env', '-e', '--privileged']) assert.equal(dockerArgs.includes(forbidden), false, forbidden);
  assert.ok(args.includes('--read-only')); assert.equal(args[args.indexOf('--pull') + 1], 'never'); assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  assert.deepEqual(Object.keys(payload).sort(), ['env', 'expected', 'profile']);
  assert.deepEqual(Object.keys(payload.env).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'FOGD_BUCKET', 'FOGD_SLOTS', 'S3_ENDPOINT']);
  assert.equal(input.includes('private-app-secret'), false); assert.equal(input.includes('private-deploy-credentials'), false);
  assert.equal(args.join('\n').includes('private-password'), false);
  assert.equal(calls.some(row => row.args.includes('create') || row.args.includes('up') || row.args.includes('stop') || row.args[0] === 'volume' && !['ls', 'inspect'].includes(row.args[1])), false);
  assert.deepEqual(calls.filter(row => row.args[0] === 'volume' && row.args[1] === 'inspect').map(row => row.args), [['volume', 'inspect', f.plan.config.volumes['runtime-policy'].name]]);
});
test('foreign policy storage refuses observation before any metadata or networked helper', async t => {
  const f = await observationFixture(t);
  await assert.rejects(f.invoke(undefined, { FOGD_OBSERVE_FOREIGN_POLICY: 'other-project' }), /not owned local project storage/);
  assert.equal((await f.calls()).some(row => row.args[0] === 'run'), false);
});
for (const args of [[], ['sample'], ['../app', '--installation', 'original'], ['sample', '--installation', '../escape'], ['sample', 'extra', '--installation', 'original'], ['sample', '--installation', 'original', '--unknown']]) test(`bad observation arguments refuse before Docker: ${JSON.stringify(args)}`, async t => {
  const f = await observationFixture(t); await assert.rejects(f.invoke(args), error => error.code === 1); assert.deepEqual(await f.calls(), []);
});
for (const role of ['controller', 'runtime-policy']) test(`missing ${role} volume is refused before any mount can create it`, async t => {
  const f = await observationFixture(t);
  await assert.rejects(f.invoke(undefined, { FOGD_OBSERVE_MISSING_VOLUME: role }), error => /volume is absent/.test(error.stderr));
  assert.equal((await f.calls()).some(row => row.args[0] === 'run'), false);
});
test('untrusted network membership makes observation uncertain without starting a networked helper', async t => {
  const f = await observationFixture(t), output = await report(f, { FOGD_OBSERVE_FOREIGN_NETWORK: 'other-project' });
  assert.equal(output.nativeReadiness, 'uncertain'); assert.equal(output.controllerRecord, 'matched-at-boundaries'); assert.equal(output.reason, 'local-scope-unconfirmed');
  assert.equal((await f.calls()).some(networkObserver), false);
});
for (const extra of [{ FOGD_OBSERVE_UNVERIFIED: '1' }, { FOGD_OBSERVE_CONTROLLER_STOPPED: '1' }, { FOGD_OBSERVE_STATE_CHANGE: '1' }]) test(`partial native evidence remains uncertain: ${JSON.stringify(extra)}`, async t => {
  const f = await observationFixture(t), output = await report(f, extra); assert.equal(output.nativeReadiness, 'uncertain');
  if (extra.FOGD_OBSERVE_STATE_CHANGE) assert.equal(output.controllerRecord, 'changed');
  if (extra.FOGD_OBSERVE_CONTROLLER_STOPPED) assert.equal(output.controllerProcess, 'not-running');
  if (extra.FOGD_OBSERVE_UNVERIFIED) assert.equal(output.runtimeIdentity, 'unconfirmed');
});
test('pending-only state makes no networked probe and does not invent native readiness', async t => {
  const f = await observationFixture(t), data = JSON.parse(await readFile(f.data, 'utf8'));
  data.state.apps = {}; for (const release of Object.values(data.state.deployments)) { release.status = 'pending'; release.step = 'submitted'; }
  await writeFile(f.data, JSON.stringify(data));
  const output = await report(f); assert.equal(output.nativeReadiness, 'not-observed'); assert.equal(output.controllerRecord, 'single-read');
  assert.equal((await f.calls()).some(networkObserver), false);
});
test('corrupted state never appears in the diagnostic', async t => {
  const f = await observationFixture(t);
  await assert.rejects(f.invoke(undefined, { FOGD_OBSERVE_CORRUPT_STATE: '1' }), error => /Cannot read local controller state/.test(error.stderr) && !error.stderr.includes('private-invalid-state') && error.stdout === '');
});
test('a failed observer is removed only by its nonce-labelled identity and reports uncertainty', async t => {
  const f = await observationFixture(t), output = await report(f, { FOGD_OBSERVE_HELPER_FAIL: '1' });
  assert.equal(output.nativeReadiness, 'uncertain');
  const calls = await f.calls(), removals = calls.filter(row => row.args[0] === 'rm'); assert.deepEqual(removals.map(row => row.args), [['rm', '-f', 'a'.repeat(64)]]);
  const checks = calls.filter(row => row.args[0] === 'ps' && row.args.some(value => value.startsWith('label=fogd.observer.id=')));
  assert.equal(checks.length, 2); assert.deepEqual(checks[0].args, checks[1].args); assert.ok(checks[0].args.some(value => value.startsWith('name=^/fogd-observe-')));
});
test('an unconfirmed observer cleanup cannot be swallowed as a normal uncertain result', async t => {
  const f = await observationFixture(t);
  await assert.rejects(f.invoke(undefined, { FOGD_OBSERVE_HELPER_FAIL: '1', FOGD_OBSERVE_CLEANUP_FAIL: '1' }), error => error.code === 1 && /cleanup is unconfirmed/.test(error.stderr) && error.stdout === '');
});

test('a recorded paused app exposes native facts while readiness remains uncertain', async t => {
  const f = await observationFixture(t), data = JSON.parse(await readFile(f.data, 'utf8'));
  data.state.apps.sample.route = 'paused'; await writeFile(f.data, JSON.stringify(data));
  const output = await report(f); assert.equal(output.nativeReadiness, 'uncertain'); assert.equal(output.reason, 'controller-withholds-application');
  assert.equal(output.runtimeIdentity, 'verified'); assert.equal(output.runtimeLeases, 'current');
  assert.equal(output.replicas.length, 2); assert.equal((await f.calls()).some(networkObserver), true);
});

test('a wrong native image is refused before the networked observer starts', async t => {
  const f = await observationFixture(t), output = await report(f, { FOGD_OBSERVE_WRONG_IMAGE: '1' });
  assert.equal(output.nativeReadiness, 'uncertain'); assert.equal((await f.calls()).some(networkObserver), false);
});
test('candidate admission cannot use native observation even when its image is cached', async t => {
  const f = await observationFixture(t), catalog = join(f.root, 'cli/src/runtime/catalog.json');
  const entries = JSON.parse(await readFile(catalog, 'utf8')); for (const entry of entries) entry.admission = 'candidate';
  await writeFile(catalog, JSON.stringify(entries));
  await assert.rejects(f.invoke(), error => /requires an enrolled qualified/.test(error.stderr));
  assert.equal((await f.calls()).some(networkObserver), false);
});
test('metadata readers stay network-isolated, readonly and cap-dropped', async t => {
  const f = await observationFixture(t); await report(f);
  const readers = (await f.calls()).filter(row => row.args[0] === 'run' && row.args.includes('--mount'));
  assert.ok(readers.length >= 3);
  for (const { args } of readers) {
    assert.equal(args[args.indexOf('--network') + 1], 'none');
    assert.ok(args[args.indexOf('--mount') + 1].includes('readonly')); assert.equal(args.includes('--cap-add'), false);
    assert.equal(args[args.indexOf('--cap-drop') + 1], 'ALL');
  }
});
