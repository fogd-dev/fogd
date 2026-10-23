import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, stat, symlink, realpath, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareDurableGateway } from '../src/gateway-durable-program.mjs';
const policy = { installation: 'a'.repeat(64), slots: ['slot-1', 'slot-2'] };
const slots = [{ id: 'slot-1', nodes: ['slot-1-a', 'slot-1-b'] }, { id: 'slot-2', nodes: ['slot-2-a', 'slot-2-b'] }];
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-gateway-program-')); t.after(() => rm(root, { recursive: true, force: true }));
  const authorityPath = join(root, 'authority'), parent = join(root, 'runtime'); await mkdir(authorityPath); await mkdir(parent);
  return { root, parent, options: { policy, slots, authorityPath, listen: '*:8080' } };
}
test('prepared gateway includes the complete independent module graph and private configuration', async t => {
  const f = await fixture(t), output = await prepareDurableGateway(f.parent, f.options);
  assert.deepEqual((await readdir(output.directory)).sort(), ['gateway-authority.mjs', 'gateway-durable.js', 'gateway-forward.mjs', 'gateway.capnp', 'route-record.mjs']);
  assert.equal((await stat(output.directory)).mode & 0o777, 0o700); assert.equal((await stat(output.path)).mode & 0o777, 0o600);
  const config = await readFile(output.path, 'utf8'); assert.equal(config.includes('CONTROLLER'), false); assert.equal(config.includes('writable = false'), true);
  const { default: gateway } = await import(pathToFileURL(join(output.directory, 'gateway-durable.js')));
  const response = await gateway.fetch(new Request('http://unknown.localhost/'), { ROUTE_POLICY: JSON.stringify(policy), ROUTE_AUTHORITY: { async fetch() { return Response.json({ schema: 1, installation: policy.installation, revision: '0', routes: [] }); } } });
  assert.equal(response.status, 404); assert.equal(await response.text(), 'Unknown app');
});
test('preparation refuses a missing authority directory without creating it', async t => {
  const f = await fixture(t), authorityPath = join(f.root, 'missing');
  await assert.rejects(prepareDurableGateway(f.parent, { ...f.options, authorityPath }), { code: 'ENOENT' });
  await assert.rejects(stat(authorityPath), { code: 'ENOENT' }); assert.deepEqual(await readdir(f.parent), []);
});
test('program and TLS files cannot be staged within the public authority mount', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareDurableGateway(f.options.authorityPath, f.options), /separate from its authority/);
  assert.deepEqual(await readdir(f.options.authorityPath), []);
});
test('an aliased runtime parent inside authority is refused before any program is written', async t => {
  const f = await fixture(t), nested = join(f.options.authorityPath, 'nested'), alias = join(f.root, 'alias'); await mkdir(nested); await symlink(nested, alias);
  await assert.rejects(prepareDurableGateway(alias, f.options), /separate from its authority/);
  assert.deepEqual(await readdir(nested), []);
});

test('an authority alias is resolved in the generated disk binding', async t => {
  const f = await fixture(t), alias = join(f.root, 'authority-alias'); await symlink(f.options.authorityPath, alias);
  const output = await prepareDurableGateway(f.parent, { ...f.options, authorityPath: alias });
  const config = await readFile(output.path, 'utf8');
  assert.ok(config.includes(`disk = (path = ${JSON.stringify(await realpath(f.options.authorityPath))}, writable = false)`));
  assert.equal(config.includes(alias), false);
});
test('invalid TLS refuses before staging any program or key', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareDurableGateway(f.parent, { ...f.options, tls: { cert: 'invalid', key: 'private-invalid' } }), /currently valid PEM/);
  assert.deepEqual(await readdir(f.parent), []);
});
test('TLS staging keeps the key and certificate private and outside authority', async t => {
  const f = await fixture(t), key = join(f.root, 'key.pem'), cert = join(f.root, 'cert.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost']);
  const tls = { key: await readFile(key, 'utf8'), cert: await readFile(cert, 'utf8') };
  const output = await prepareDurableGateway(f.parent, { ...f.options, tls });
  for (const [name, expected] of [['key.pem', tls.key], ['cert.pem', tls.cert]]) {
    assert.equal(await readFile(join(output.directory, name), 'utf8'), expected);
    assert.equal((await stat(join(output.directory, name))).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(f.options.authorityPath), []);
});

test('a failed program copy removes only its newly created staging directory', async t => {
  const f = await fixture(t), sources = join(f.root, 'incomplete-sources'); await mkdir(sources);
  // Load a real preparer with a deliberately incomplete source inventory.
  for (const name of ['gateway-durable-program.mjs', 'gateway-durable-config.mjs', 'route-record.mjs', 'transport.mjs']) {
    await copyFile(new URL(`../src/${name}`, import.meta.url), join(sources, name));
  }
  const { prepareDurableGateway: incomplete } = await import(pathToFileURL(join(sources, 'gateway-durable-program.mjs')));
  await assert.rejects(incomplete(f.parent, f.options), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.parent), []);
  assert.deepEqual(await readdir(f.options.authorityPath), []);
  assert.equal((await readdir(sources)).length, 4);
});
