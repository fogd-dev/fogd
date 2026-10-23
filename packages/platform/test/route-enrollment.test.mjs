import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm, chmod, symlink, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { issueRouteEnrollment, spendRouteEnrollment } from '../src/route-enrollment.mjs';
import { initializeRouteEnrollment } from '../src/route-initialize.mjs';
import { policy } from './fixtures/runtime-policy.mjs';
import { runtimePolicyIdentity } from '../src/runtime-policy.mjs';
import { Controller } from '../src/controller.mjs';
import { startupRouting } from '../src/startup-routing.mjs';

const grantName = 'route-enrollment.json', spentName = 'route-enrollment.spent.json';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-enrollment-')); t.after(() => rm(root, { recursive: true, force: true }));
  const input = { profile: policy(), binding: 'b'.repeat(64), controller: join(root, 'private'), authority: join(root, 'authority'), enrollment: join(root, 'enrollment') };
  await mkdir(input.controller, { mode: 0o700 }); await mkdir(input.authority, { mode: 0o755 }); await mkdir(input.enrollment, { mode: 0o700 });
  return { root, input };
}
const request = (f, grant) => ({ ...f.input, id: grant.id });
function ordinaryController(input, routeOptions = {}) {
  let controller; const slots = input.profile.fleets.map(fleet => ({ id: fleet.id, prefix: fleet.prefix, nodes: fleet.nodes.map(node => node.host) }));
  controller = new Controller({ dir: input.controller, slots, backend: { owner: async () => null }, routeAuthority: { ...startupRouting({ path: join(input.authority, 'routes.json') }, input.profile, () => controller), ...routeOptions } });
  return controller;
}

test('enrollment is spent durably before empty route stores are initialized and ordinary startup retains them', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input);
  const receipt = await initializeRouteEnrollment(request(f, grant));
  assert.equal(receipt.installation, runtimePolicyIdentity(f.input.profile)); assert.equal(receipt.revision, '0');
  const state = JSON.parse(await readFile(join(f.input.controller, 'state.json'), 'utf8'));
  assert.equal(state.routeAuthority.pending, null); assert.deepEqual(state.apps, {}); assert.equal(state.routeAuthority.settled.digest, receipt.sha256);
  const record = JSON.parse(await readFile(join(f.input.authority, 'routes.json'), 'utf8')); assert.deepEqual(record.routes, []); assert.equal(record.installation, receipt.installation);
  const spent = JSON.parse(await readFile(join(f.input.enrollment, spentName), 'utf8')); assert.equal(spent.id, grant.id);
  for (const name of [grantName, spentName]) assert.equal((await stat(join(f.input.enrollment, name))).mode & 0o777, 0o600);
  const controller = ordinaryController(f.input);
  await controller.init(); assert.equal(controller.routingStartupComplete, true);
  await assert.rejects(initializeRouteEnrollment(request(f, grant)), { code: 'ROUTE_ENROLLMENT_SPENT' });
});
test('interruption after spending and before a private intent cannot replay initialization', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input); await spendRouteEnrollment(request(f, grant));
  await assert.rejects(initializeRouteEnrollment(request(f, grant)), { code: 'ROUTE_ENROLLMENT_SPENT' });
  assert.deepEqual(await readdir(f.input.controller), []); assert.deepEqual(await readdir(f.input.authority), []);
});
test('an incomplete spent marker is a final fence even though it cannot be parsed', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input); await writeFile(join(f.input.enrollment, spentName), '', { mode: 0o600 });
  await assert.rejects(initializeRouteEnrollment(request(f, grant)), { code: 'ROUTE_ENROLLMENT_SPENT' });
  assert.deepEqual(await readdir(f.input.controller), []);
});
test('concurrent initialization attempts consume one grant and produce exactly one initial authority', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input);
  const results = await Promise.allSettled([initializeRouteEnrollment(request(f, grant)), initializeRouteEnrollment(request(f, grant))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ROUTE_ENROLLMENT_SPENT');
  const record = JSON.parse(await readFile(join(f.input.authority, 'routes.json'), 'utf8')); assert.equal(record.revision, '0');
});
for (const [name, change] of [
  ['foreign layout binding', value => { value.binding = 'c'.repeat(64); }],
  ['foreign native profile', value => { value.profile.binarySha256 = 'd'.repeat(64); }],
  ['foreign installation', value => { value.profile.fleets[0].nodes[0].id = 'another-node'; }],
  ['wrong grant id', value => { value.id = '00000000-0000-4000-8000-000000000001'; }],
]) test(`${name} refuses without consuming a matching grant or writing target stores`, async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input), input = structuredClone(request(f, grant)); change(input);
  await assert.rejects(initializeRouteEnrollment(input), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(f.input.enrollment), [grantName]); assert.deepEqual(await readdir(f.input.controller), []);
  await initializeRouteEnrollment(request(f, grant));
});
test('grant issuance refuses retained data rather than treating it as fresh', async t => {
  const f = await fixture(t); await writeFile(join(f.input.controller, 'credentials.json'), 'retained-private-data');
  await assert.rejects(issueRouteEnrollment(f.input), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(f.input.enrollment), []); assert.equal(await readFile(join(f.input.controller, 'credentials.json'), 'utf8'), 'retained-private-data');
});
test('data that appears after issuance refuses before grant spending and remains untouched', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input); await writeFile(join(f.input.authority, 'routes.json'), 'retained-authority');
  await assert.rejects(initializeRouteEnrollment(request(f, grant)), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(f.input.enrollment), [grantName]); assert.equal(await readFile(join(f.input.authority, 'routes.json'), 'utf8'), 'retained-authority');
});
test('copying a grant into another private directory does not transfer its enrollment identity', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input), other = join(f.root, 'other'); await mkdir(other, { mode: 0o700 });
  await copyFile(join(f.input.enrollment, grantName), join(other, grantName));
  await assert.rejects(initializeRouteEnrollment({ ...request(f, grant), enrollment: other }), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(other), [grantName]);
});
for (const name of ['controller', 'authority', 'enrollment']) test(`${name} directory cannot alias another storage role`, async t => {
  const f = await fixture(t);
  await assert.rejects(issueRouteEnrollment({ ...f.input, [name]: name === 'authority' ? f.input.controller : f.input.authority }), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(f.input.enrollment), []);
});
test('a symlinked grant file and weaker directory permissions refuse without consuming authority', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input), original = join(f.root, 'grant-copy.json');
  await copyFile(join(f.input.enrollment, grantName), original); await rm(join(f.input.enrollment, grantName)); await symlink(original, join(f.input.enrollment, grantName));
  await assert.rejects(initializeRouteEnrollment(request(f, grant)), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  await rm(join(f.input.enrollment, grantName)); await copyFile(original, join(f.input.enrollment, grantName)); await chmod(f.input.enrollment, 0o755);
  await assert.rejects(initializeRouteEnrollment(request(f, grant)), { code: 'ROUTE_ENROLLMENT_REFUSED' });
});

for (const phase of ['before', 'after']) test(`real stopped initialization recovers its intent after failure ${phase} public creation`, async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input);
  const { createRouteRecord } = await import('../src/route-record-store.mjs');
  const path = join(f.input.authority, 'routes.json'); let reached = false;
  await assert.rejects(initializeRouteEnrollment(request(f, grant), { async createPublic(file, record, routePolicy) {
    reached = true;
    assert.equal(JSON.parse(await readFile(join(f.input.enrollment, spentName), 'utf8')).id, grant.id);
    assert.equal(JSON.parse(await readFile(join(f.input.controller, 'state.json'), 'utf8')).routeAuthority.pending.kind, 'initialize');
    if (phase === 'after') await createRouteRecord(file, record, routePolicy);
    throw new Error('PRIVATE injected public acknowledgment failure');
  } }), error => error.code === 'ROUTE_INITIALIZATION_UNCERTAIN' && !error.message.includes('PRIVATE') && !('cause' in error) && !inspect(error).includes('PRIVATE'));
  assert.equal(reached, true);
  const before = phase === 'after' ? await readFile(path) : null;
  const controller = ordinaryController(f.input); await controller.init(); assert.equal(controller.state.routeAuthority.pending, null);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).revision, '0');
  if (before) assert.deepEqual(await readFile(path), before);
  assert.equal(JSON.parse(await readFile(join(f.input.enrollment, spentName), 'utf8')).id, grant.id);
});
test('competing grant consumers receive only one durable spending receipt', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input);
  const attempts = await Promise.allSettled([spendRouteEnrollment(request(f, grant)), spendRouteEnrollment(request(f, grant))]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(value => value.status === 'rejected').length, 1);
  assert.equal(attempts.find(value => value.status === 'rejected').reason.code, 'ROUTE_ENROLLMENT_SPENT');
  assert.deepEqual(await readdir(f.input.controller), []); assert.deepEqual(await readdir(f.input.authority), []);
});
test('two issuers cannot replace each other or return two grant receipts', async t => {
  const f = await fixture(t), attempts = await Promise.allSettled([issueRouteEnrollment(f.input), issueRouteEnrollment(f.input)]);
  const accepted = attempts.filter(value => value.status === 'fulfilled'); assert.equal(accepted.length, 1);
  assert.equal(attempts.find(value => value.status === 'rejected').reason.code, 'ROUTE_ENROLLMENT_REFUSED');
  const record = JSON.parse(await readFile(join(f.input.enrollment, grantName), 'utf8')); assert.equal(record.id, accepted[0].value.id);
});
for (const mode of [0o705, 0o777]) test(`authority directory mode ${mode.toString(8)} refuses before issuing a grant`, async t => {
  const f = await fixture(t); await chmod(f.input.authority, mode);
  await assert.rejects(issueRouteEnrollment(f.input), { code: 'ROUTE_ENROLLMENT_REFUSED' }); assert.deepEqual(await readdir(f.input.enrollment), []);
});
for (const [name, value] of [['oversized', ' '.repeat(32769)], ['invalid UTF-8', new Uint8Array([255])], ['malformed JSON', 'PRIVATE invalid grant']]) test(`${name} grant data refuses without creating a spent marker`, async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input); await writeFile(join(f.input.enrollment, grantName), value, { mode: 0o600 });
  await assert.rejects(initializeRouteEnrollment(request(f, grant)), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(f.input.enrollment), [grantName]); assert.deepEqual(await readdir(f.input.controller), []);
});

test('private state and enrollment cannot share a directory even when their permissions match', async t => {
  const f = await fixture(t);
  await assert.rejects(issueRouteEnrollment({ ...f.input, enrollment: f.input.controller }), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(f.input.controller), []);
});
for (const child of ['controller', 'enrollment']) test(`nested ${child} storage refuses despite matching private permissions`, async t => {
  const f = await fixture(t), parent = child === 'controller' ? 'enrollment' : 'controller';
  const nested = join(f.input[parent], 'nested'); await mkdir(nested, { mode: 0o700 });
  await assert.rejects(issueRouteEnrollment({ ...f.input, [child]: nested }), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(nested), []);
});
for (const phase of ['before', 'after', 'settled']) test(`enrollment ${phase} public creation cannot resume at a different authority directory`, async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input);
  if (phase === 'settled') await initializeRouteEnrollment(request(f, grant));
  else {
    const { createRouteRecord } = await import('../src/route-record-store.mjs');
    await assert.rejects(initializeRouteEnrollment(request(f, grant), { async createPublic(file, record, routePolicy) {
      if (phase === 'after') await createRouteRecord(file, record, routePolicy);
      throw new Error('interrupted');
    } }), { code: 'ROUTE_INITIALIZATION_UNCERTAIN' });
  }
  const other = join(f.root, 'other-authority'); await mkdir(other, { mode: 0o755 });
  if (phase !== 'before') await copyFile(join(f.input.authority, 'routes.json'), join(other, 'routes.json'));
  const saved = await readFile(join(f.input.controller, 'state.json'));
  await assert.rejects(ordinaryController({ ...f.input, authority: other }).init(), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readFile(join(f.input.controller, 'state.json')), saved);
  assert.deepEqual(await readdir(other), phase === 'before' ? [] : ['routes.json']);
  await ordinaryController(f.input).init();
});
test('copied private state cannot resume an interrupted enrollment at a different controller directory', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input);
  await assert.rejects(initializeRouteEnrollment(request(f, grant), { createPublic() { throw new Error('interrupted'); } }), { code: 'ROUTE_INITIALIZATION_UNCERTAIN' });
  const other = join(f.root, 'other-private'); await mkdir(other, { mode: 0o700 });
  await copyFile(join(f.input.controller, 'state.json'), join(other, 'state.json'));
  await assert.rejects(ordinaryController({ ...f.input, controller: other }).init(), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(other), ['state.json']); assert.deepEqual(await readdir(f.input.authority), []);
  await ordinaryController(f.input).init();
});
test('replacing an empty target at the same path does not preserve its grant binding', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input), old = join(f.root, 'retained-original');
  const { rename } = await import('node:fs/promises'); await rename(f.input.controller, old); await mkdir(f.input.controller, { mode: 0o700 });
  await assert.rejects(initializeRouteEnrollment(request(f, grant)), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(f.input.enrollment), [grantName]);
  await rm(f.input.controller, { recursive: true }); await rename(old, f.input.controller);
  await initializeRouteEnrollment(request(f, grant));
});

test('ordinary startup refuses a spent attempt with no intent before writing any target data', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input); await spendRouteEnrollment(request(f, grant));
  await assert.rejects(ordinaryController(f.input).init(), { code: 'ROUTE_ENROLLMENT_REQUIRED' });
  assert.deepEqual(await readdir(f.input.controller), []); assert.deepEqual(await readdir(f.input.authority), []);
});
test('ordinary startup preserves execution data when enrollment metadata is absent', async t => {
  const f = await fixture(t), execution = join(f.input.controller, 'execution'); await mkdir(execution, { mode: 0o700 });
  await writeFile(join(execution, 'retained.txt'), 'retained execution');
  await assert.rejects(ordinaryController(f.input).init(), { code: 'ROUTE_ENROLLMENT_REQUIRED' });
  assert.deepEqual(await readdir(f.input.controller), ['execution']); assert.equal(await readFile(join(execution, 'retained.txt'), 'utf8'), 'retained execution');
});
test('ordinary startup never recreates a missing controller storage path', async t => {
  const f = await fixture(t); await rm(f.input.controller, { recursive: true });
  await assert.rejects(ordinaryController(f.input).init(), { code: 'ROUTE_ENROLLMENT_REQUIRED' });
  await assert.rejects(stat(f.input.controller), { code: 'ENOENT' });
});
for (const fresh of [true, false]) test(`direct Controller construction rejects a fresh=${fresh} initialization flag`, async t => {
  const f = await fixture(t); assert.throws(() => ordinaryController(f.input, { fresh }), /does not accept initialization flags/);
  assert.deepEqual(await readdir(f.input.controller), []); assert.deepEqual(await readdir(f.input.authority), []);
});

test('missing retained authority refuses ordinary startup before execution or artifact writes', async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input); await initializeRouteEnrollment(request(f, grant));
  await rm(join(f.input.authority, 'routes.json'));
  const before = await readFile(join(f.input.controller, 'state.json'));
  await assert.rejects(ordinaryController(f.input).init(), { code: 'ROUTE_PUBLICATION_UNCERTAIN' });
  assert.deepEqual(await readdir(f.input.controller), ['state.json']); assert.deepEqual(await readFile(join(f.input.controller, 'state.json')), before);
  assert.deepEqual(await readdir(f.input.authority), []);
});
test('malformed enrollment metadata refuses without preparing working directories', async t => {
  const f = await fixture(t), state = JSON.stringify({ apps: {}, deployments: {}, routeAuthority: {} }); await writeFile(join(f.input.controller, 'state.json'), state);
  await assert.rejects(ordinaryController(f.input).init(), { code: 'ROUTE_PUBLICATION_UNCERTAIN' });
  assert.deepEqual(await readdir(f.input.controller), ['state.json']); assert.equal(await readFile(join(f.input.controller, 'state.json'), 'utf8'), state);
});
for (const [name, change] of [
  ['missing', state => { delete state.routeEnrollment; }],
  ['null', state => { state.routeEnrollment = null; }],
  ['extra key', state => { state.routeEnrollment.extra = true; }],
  ['wrong inode', state => { state.routeEnrollment.authority.inode = '0'; }],
]) test(`settled enrollment refuses ${name} directory binding without writes`, async t => {
  const f = await fixture(t), grant = await issueRouteEnrollment(f.input); await initializeRouteEnrollment(request(f, grant));
  const path = join(f.input.controller, 'state.json'), state = JSON.parse(await readFile(path, 'utf8')); change(state);
  const saved = JSON.stringify(state); await writeFile(path, saved);
  const publicBytes = await readFile(join(f.input.authority, 'routes.json'));
  await assert.rejects(ordinaryController(f.input).init(), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.deepEqual(await readdir(f.input.controller), ['state.json']); assert.equal(await readFile(path, 'utf8'), saved);
  assert.deepEqual(await readFile(join(f.input.authority, 'routes.json')), publicBytes);
});
test('direct controller configuration cannot substitute a different authority filename', async t => {
  const f = await fixture(t);
  assert.throws(() => ordinaryController(f.input, { path: join(f.input.authority, 'other.json') }), /absolute routes.json/);
  assert.deepEqual(await readdir(f.input.authority), []);
});
