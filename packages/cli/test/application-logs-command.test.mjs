import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, access, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { observationFixture } from './fixtures/observation-cli.mjs';

const id = role => createHash('sha256').update(role).digest('hex');
const logCalls = calls => calls.filter(row => row.args[0] === 'logs');
async function fixture(t) {
  const f = await observationFixture(t), output = join(f.root, 'capture'), data = JSON.parse(await readFile(f.data, 'utf8'));
  const otherId = '00000000-0000-4000-8000-000000000002';
  data.state.apps['other-app'] = { active: otherId, route: 'active', slot: 'slot-2' };
  data.state.deployments[otherId] = { id: otherId, app: 'other-app', digest: 'b'.repeat(64), status: 'active', step: 'complete', version: 'private-other-version' };
  await writeFile(f.data, JSON.stringify(data));
  return { ...f, output,
    logs: (extra = {}, args = []) => f.invoke(['sample', '--installation', f.project, '--output', output, ...args], { FOGD_LOG_TEST: '1', ...extra }) };
}
const mode = async path => (await stat(path)).mode & 0o777;

test('owner capture saves only the selected app replica streams privately and leaves secrets off the terminal', async t => {
  const f = await fixture(t), result = await f.logs(), report = JSON.parse(result.stdout), calls = await f.calls();
  assert.equal(report.status, 'captured'); assert.equal(report.disclosure, 'unredacted-owner-only');
  assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, /private-app-secret|private-storage-password|private-owner-response|other-app|slot-2/);
  assert.deepEqual(logCalls(calls).map(row => row.args), ['slot-1-a', 'slot-1-b'].map(role => ['logs', '--timestamps', '--tail', '2000', id(role)]));
  assert.equal(await mode(f.output), 0o700); assert.equal(await mode(join(f.output, 'capture.json')), 0o600);
  assert.equal(await readFile(join(f.output, 'slot-1-a.stdout.log'), 'utf8'), 'private-slot-1-a-console private-app-secret\n');
  assert.equal(await readFile(join(f.output, 'slot-1-b.stderr.log'), 'utf8'), 'private-slot-1-b-runtime private-storage-password\n');
  assert.equal(await mode(join(f.output, 'slot-1-a.stdout.log')), 0o600);
  assert.equal((await readFile(join(f.output, 'capture.json'), 'utf8')).includes('private-app-secret'), false);
  const owners = calls.filter(row => row.args[0] === 'run' && row.args.at(-1).includes('.owner(slot)'));
  assert.equal(owners.length, 2);
  assert.equal(owners[0].args[owners[0].args.indexOf('--network') + 1], f.plan.config.networks.control.name);
  assert.deepEqual(Object.keys(JSON.parse(owners[0].input).env).sort(), ['AWS_ACCESS_KEY_ID', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'FOGD_BUCKET', 'FOGD_SLOTS', 'S3_ENDPOINT']);
  assert.equal(owners[0].input.includes('private-app-secret'), false);
  assert.deepEqual(JSON.parse(owners[0].input).expected, { slot: 'slot-1', app: 'sample' });
});

test('a stopped replica remains readable without starting it', async t => {
  const f = await fixture(t), report = JSON.parse((await f.logs({ FOGD_LOG_STOPPED_REPLICA: 'slot-1-b' })).stdout);
  assert.equal(report.status, 'captured'); assert.equal(report.captures.length, 2);
  assert.equal((await f.calls()).some(row => ['start', 'restart', 'create', 'up', 'stop'].includes(row.args[0])), false);
});

test('an assigned app failing before its first activation remains diagnosable', async t => {
  const f = await fixture(t), data = JSON.parse(await readFile(f.data, 'utf8')), release = data.state.apps.sample.active;
  Object.assign(data.state.apps.sample, { route: 'paused', active: null, uncertain: release });
  Object.assign(data.state.deployments[release], { status: 'failed', step: 'migrating' }); await writeFile(f.data, JSON.stringify(data));
  const report = JSON.parse((await f.logs()).stdout); assert.equal(report.status, 'captured'); assert.equal(report.recorded.active, null);
  assert.equal(logCalls(await f.calls()).length, 2);
});

for (const extra of [{ FOGD_LOG_OWNER_MISMATCH: '1' }, { FOGD_OBSERVE_FOREIGN_NETWORK: 'foreign' }, { FOGD_OBSERVE_WRONG_IMAGE: '1' }]) test(`unverified fleet scope refuses before any log command: ${JSON.stringify(extra)}`, async t => {
  const f = await fixture(t);
  await assert.rejects(f.logs(extra), error => error.code === 1 && error.stdout === '' && !error.stderr.includes('private-'));
  assert.deepEqual(logCalls(await f.calls()), []); await assert.rejects(access(f.output), { code: 'ENOENT' });
});

for (const details of [{ slot: null }, { quarantined: true }, { retirement: {} }]) test(`unassigned or withheld app scope cannot collect logs: ${JSON.stringify(details)}`, async t => {
  const f = await fixture(t), data = JSON.parse(await readFile(f.data, 'utf8')); Object.assign(data.state.apps.sample, details); await writeFile(f.data, JSON.stringify(data));
  await assert.rejects(f.logs(), error => error.code === 1); assert.deepEqual(logCalls(await f.calls()), []);
});

test('a changed controller record retains private files with an unconfirmed capture and nonzero exit', async t => {
  const f = await fixture(t);
  await assert.rejects(f.logs({ FOGD_LOG_SCOPE_CHANGE: '1' }), error => {
    const report = JSON.parse(error.stdout); assert.equal(report.status, 'scope-unconfirmed'); assert.equal(report.scope.controllerRecord, 'changed');
    return error.code === 1 && !error.stdout.includes('private-app-secret');
  });
  assert.match(await readFile(join(f.output, 'slot-1-a.stdout.log'), 'utf8'), /private-app-secret/);
});

test('log command failure preserves private stderr without claiming a complete capture', async t => {
  const f = await fixture(t);
  await assert.rejects(f.logs({ FOGD_LOG_EXIT_CODE: '3' }), error => error.code === 1 && JSON.parse(error.stdout).status === 'partial' && !error.stdout.includes('private-storage-password'));
  assert.match(await readFile(join(f.output, 'slot-1-a.stderr.log'), 'utf8'), /private-storage-password/);
});

test('an existing output directory is preserved and receives no log data', async t => {
  const f = await fixture(t); await mkdir(f.output); await writeFile(join(f.output, 'keep'), 'original');
  await assert.rejects(f.logs(), error => error.code === 1 && /new directory/.test(error.stderr));
  assert.equal(await readFile(join(f.output, 'keep'), 'utf8'), 'original'); assert.deepEqual(logCalls(await f.calls()), []);
});

for (const args of [['--tail', '0'], ['--tail', '10001'], ['--tail', '2.5'], ['--follow']]) test(`bad log options refuse before Docker: ${JSON.stringify(args)}`, async t => {
  const f = await fixture(t); await assert.rejects(f.logs({}, args), error => error.code === 1); assert.deepEqual(await f.calls(), []);
});

test('lost ownership confirmation after collection keeps files but refuses a confirmed capture', async t => {
  const f = await fixture(t);
  await assert.rejects(f.logs({ FOGD_LOG_OWNER_FAIL_AFTER_CAPTURE: '1' }), error => error.code === 1 && JSON.parse(error.stdout).scope.owner === 'unconfirmed' && JSON.parse(error.stdout).status === 'scope-unconfirmed');
  assert.match(await readFile(join(f.output, 'slot-1-a.stderr.log'), 'utf8'), /private-storage-password/);
});

test('a missing selected replica refuses before collecting its surviving peer', async t => {
  const f = await fixture(t), data = JSON.parse(await readFile(f.data, 'utf8')); data.missingContainer = 'slot-1-b'; await writeFile(f.data, JSON.stringify(data));
  await assert.rejects(f.logs(), error => error.code === 1); assert.deepEqual(logCalls(await f.calls()), []);
  await assert.rejects(access(f.output), { code: 'ENOENT' });
});

test('a replica pointing at another app namespace refuses before log collection', async t => {
  const f = await fixture(t), data = JSON.parse(await readFile(f.data, 'utf8'));
  const env = f.plan.config.services['slot-1-a'].environment;
  data.replicaOverrides = { 'slot-1-a': { Config: { Env: ['PATH=/usr/local/bin:/usr/bin:/bin', ...Object.entries({ ...env, CELLD_BUCKET: 's3://fogd/slots/slot-2' }).map(([key,value]) => `${key}=${value}`)] } } };
  await writeFile(f.data, JSON.stringify(data));
  await assert.rejects(f.logs(), error => error.code === 1 && !error.stderr.includes('slot-2')); assert.deepEqual(logCalls(await f.calls()), []);
});

test('a replica mounting another app disk refuses before log collection', async t => {
  const f = await fixture(t), data = JSON.parse(await readFile(f.data, 'utf8'));
  data.replicaOverrides = { 'slot-1-a': { Mounts: [{ Type: 'volume', Name: f.plan.config.volumes['slot-2-a'].name, Destination: '/var/lib/celld', RW: true }] } };
  await writeFile(f.data, JSON.stringify(data));
  await assert.rejects(f.logs(), error => error.code === 1); assert.deepEqual(logCalls(await f.calls()), []);
});

test('installation records cannot be used as a private log output directory', async t => {
  const f = await fixture(t), directory = join(f.root, '.fogd/installations', f.project), before = await readFile(join(directory, 'compose.json'));
  await assert.rejects(f.logs({}, ['--output', join(directory, 'logs')]), error => error.code === 1 && /outside installation records/.test(error.stderr));
  assert.deepEqual(logCalls(await f.calls()), []); assert.deepEqual(await readFile(join(directory, 'compose.json')), before);
  await assert.rejects(access(join(directory, 'logs')), { code: 'ENOENT' });
});

test('a stopped controller does not prevent private capture from its retained assigned fleet', async t => {
  const f = await fixture(t), report = JSON.parse((await f.logs({ FOGD_OBSERVE_CONTROLLER_STOPPED: '1' })).stdout);
  assert.equal(report.status, 'captured'); assert.equal(report.scope.controllerRecord, 'matched-at-boundaries');
  assert.equal(logCalls(await f.calls()).length, 2);
});

test('an output parent alias cannot place private logs inside installation records', async t => {
  const f = await fixture(t), directory = join(f.root, '.fogd/installations', f.project), alias = join(f.root, 'alias');
  await symlink(directory, alias);
  await assert.rejects(f.logs({}, ['--output', join(alias, 'logs')]), error => error.code === 1 && /outside installation records/.test(error.stderr));
  assert.deepEqual(logCalls(await f.calls()), []); await assert.rejects(access(join(directory, 'logs')), { code: 'ENOENT' });
});

test('a declared null control attachment permits scoped log ownership inspection', async t => {
  const f = await observationFixture(t, { durable: true }), data = JSON.parse(await readFile(f.data, 'utf8'));
  data.config.services.controller.networks.control = null;
  await writeFile(f.data, JSON.stringify(data));
  await writeFile(join(f.root, '.fogd/installations', f.project, 'compose.json'), JSON.stringify(data.config));
  const output = join(f.root, 'capture');
  const result = await f.invoke(['sample', '--installation', f.project, '--output', output], { FOGD_LOG_TEST: '1' });
  assert.equal(JSON.parse(result.stdout).status, 'captured');
  assert.equal(logCalls(await f.calls()).length, 2);
});
