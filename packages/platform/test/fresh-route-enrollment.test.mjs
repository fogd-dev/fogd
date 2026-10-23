import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { initializeFreshRouteStores } from '../src/fresh-route-enrollment.mjs';
import { runtimePolicyIdentity } from '../src/runtime-policy.mjs';
import { policy } from './fixtures/runtime-policy.mjs';

const durable = () => ({ ...policy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] });
const roles = ['controller', 'authority', 'enrollment'];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-fresh-routes-')); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(roles.map(role => [role, join(root, role)]));
  // Fresh Docker volumes are 0755; initialization tightens private roles itself.
  for (const path of Object.values(paths)) await mkdir(path, { mode: 0o755 });
  return { root, paths, input: { profile: durable(), binding: 'b'.repeat(64) } };
}
async function unchanged(f, expected = {}) {
  for (const role of roles) assert.deepEqual(await readdir(f.paths[role]), expected[role] || [], role);
}

test('fresh stores are tightened, enrolled, spent and initialized in one call', async t => {
  const f = await fixture(t), receipt = await initializeFreshRouteStores(f.input, f.paths);
  const installation = runtimePolicyIdentity(f.input.profile), slots = ['slot-1', 'slot-2'];
  const empty = encodeRouteRecord({ schema: 1, installation, revision: '0', routes: [] }, { installation, slots });
  assert.deepEqual(Object.keys(receipt), ['id', 'installation', 'binding', 'revision', 'sha256']);
  assert.match(receipt.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual({ ...receipt, id: null }, { id: null, installation, binding: f.input.binding, revision: '0', sha256: createHash('sha256').update(empty).digest('hex') });
  assert.equal(await readFile(join(f.paths.authority, 'routes.json'), 'utf8'), empty);
  assert.deepEqual((await readdir(f.paths.enrollment)).sort(), ['route-enrollment.json', 'route-enrollment.spent.json']);
  assert.equal(JSON.parse(await readFile(join(f.paths.enrollment, 'route-enrollment.spent.json'), 'utf8')).id, receipt.id);
  for (const [role, mode] of [['controller', 0o700], ['authority', 0o755], ['enrollment', 0o700]]) assert.equal((await stat(f.paths[role])).mode & 0o777, mode);
  await assert.rejects(initializeFreshRouteStores(f.input, f.paths), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  assert.equal(await readFile(join(f.paths.authority, 'routes.json'), 'utf8'), empty);
});

for (const [name, change] of [
  ['retained private data', f => writeFile(join(f.paths.controller, 'state.json'), 'retained')],
  ['retained authority', f => writeFile(join(f.paths.authority, 'routes.json'), 'retained')],
  ['an existing grant', f => writeFile(join(f.paths.enrollment, 'route-enrollment.json'), 'retained')],
  ['a spent marker', f => writeFile(join(f.paths.enrollment, 'route-enrollment.spent.json'), '')],
]) test(`${name} refuses before any permission change or reissue`, async t => {
  const f = await fixture(t); await change(f);
  const before = Object.fromEntries(await Promise.all(roles.map(async role => [role, await readdir(f.paths[role])])));
  await assert.rejects(initializeFreshRouteStores(f.input, f.paths), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  await unchanged(f, before);
  for (const role of roles) assert.equal((await stat(f.paths[role])).mode & 0o777, 0o755);
  for (const role of roles) for (const file of before[role]) assert.match(await readFile(join(f.paths[role], file), 'utf8'), /^(retained)?$/);
});

for (const [name, change] of [
  ['aliased role', f => { f.paths.authority = f.paths.controller; }],
  ['nested role', async f => { f.paths.enrollment = join(f.paths.controller, 'nested'); await mkdir(f.paths.enrollment); }],
  ['symlinked role', async f => { const link = join(f.root, 'link'); await symlink(f.paths.authority, link); f.paths.authority = link; }],
  ['missing role', f => { f.paths.controller = join(f.root, 'missing'); }],
  ['relative path', f => { f.paths.controller = 'controller'; }],
]) test(`${name} refuses without creating or changing storage`, async t => {
  const f = await fixture(t), original = { ...f.paths }; await change(f);
  await assert.rejects(initializeFreshRouteStores(f.input, f.paths), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  for (const role of roles) assert.equal((await stat(original[role])).mode & 0o777, 0o755);
  assert.deepEqual((await readdir(f.root)).sort(), (name === 'symlinked role' ? [...roles, 'link'] : roles).sort());
  assert.deepEqual(await readdir(original.enrollment), []);
});

for (const [name, change] of [
  ['legacy schema profile', input => { input.profile = policy(); }],
  ['short binding', input => { input.binding = 'b'.repeat(63); }],
  ['serialized path', input => { input.controller = '/tmp/other'; }],
  ['serialized publisher', input => { input.createPublic = 'publish'; }],
  ['missing binding', input => { delete input.binding; }],
]) test(`${name} input refuses without touching stores`, async t => {
  const f = await fixture(t); change(f.input);
  await assert.rejects(initializeFreshRouteStores(f.input, f.paths), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  await unchanged(f); for (const role of roles) assert.equal((await stat(f.paths[role])).mode & 0o777, 0o755);
});

test('an uncertain public publication retains the spent grant and private intent', async t => {
  const f = await fixture(t);
  await assert.rejects(initializeFreshRouteStores(f.input, { ...f.paths, createPublic() { throw new Error('PRIVATE interrupted'); } }),
    error => error.code === 'ROUTE_INITIALIZATION_UNCERTAIN' && !error.message.includes('PRIVATE'));
  await unchanged(f, { controller: ['state.json'], enrollment: ['route-enrollment.json', 'route-enrollment.spent.json'] });
  assert.equal(JSON.parse(await readFile(join(f.paths.controller, 'state.json'), 'utf8')).routeAuthority.pending.kind, 'initialize');
  await assert.rejects(initializeFreshRouteStores(f.input, f.paths), { code: 'ROUTE_ENROLLMENT_REFUSED' });
});

test('an unreadable role refuses before a grant exists', { skip: process.geteuid() === 0 }, async t => {
  const f = await fixture(t); await chmod(f.paths.authority, 0o000);
  await assert.rejects(initializeFreshRouteStores(f.input, f.paths), { code: 'ROUTE_ENROLLMENT_REFUSED' });
  await chmod(f.paths.authority, 0o755); await unchanged(f);
  assert.equal((await stat(f.paths.controller)).mode & 0o777, 0o755);
});

const entrypoint = fileURLToPath(new URL('../src/import-route-enrollment.mjs', import.meta.url));
for (const [name, input] of [
  ['oversized', Buffer.alloc(64 * 1024 + 1, 0x20)],
  ['invalid UTF-8', Buffer.from([0xff])],
  ['BOM-prefixed', Buffer.from('﻿{}')],
  ['path-carrying', Buffer.from(JSON.stringify({ profile: durable(), binding: 'b'.repeat(64), controller: '/tmp' }))],
]) test(`entrypoint exits nonzero with no receipt for ${name} input`, () => {
  const result = spawnSync(process.execPath, [entrypoint], { input, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Route enrollment failed( \(ROUTE_[A-Z_]+\))?; keep ingress stopped and retain all stores\n$/);
});
