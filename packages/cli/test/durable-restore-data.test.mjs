import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, chmod, lstat, link, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { restoreDurableData } from '../src/recovery/durable-restore-data.mjs';
import { durableFixture } from './fixtures/durable-bundle.mjs';

import { durableDataTransport, gnuTar } from './fixtures/durable-data-transport.mjs';
const skip = gnuTar ? false : 'host GNU tar unavailable';
const dataRoles = ['bucket', 'controller', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'];
const controlRoles = ['route-authority', 'runtime-policy', 'gateway-policy', 'route-enrollment'];
const tar = (...args) => execFileSync(gnuTar, args);
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const stateIdentity = async path => {
  const stat = await lstat(path, { bigint: true });
  return { bytes: await sha(path), dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode, nlink: stat.nlink };
};
async function tree(dir, prefix = '') {
  const out = {};
  for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, item.name), name = `${prefix}${item.name}`, stat = await lstat(path);
    if (item.isDirectory()) Object.assign(out, { [`${name}/`]: stat.mode }, await tree(path, `${name}/`));
    else out[name] = item.isSymbolicLink() ? 'link' : `${stat.mode}:${await sha(path)}`;
  }
  return out;
}

async function fixture(t, edit = async () => {}) {
  const root = await mkdtemp('/tmp/fogd-restore-data-'); t.after(() => rm(root, { recursive: true, force: true }));
  const { config, policy } = durableFixture(), bundle = join(root, 'bundle'); await mkdir(bundle);
  const sources = {}, volumes = {};
  for (const role of [...dataRoles, ...controlRoles]) {
    sources[role] = join(root, 'source', role); volumes[role] = join(root, 'target', role);
    await mkdir(sources[role], { recursive: true }); await mkdir(volumes[role], { recursive: true });
  }
  await writeFile(join(sources.controller, 'state.json'), '{"source":true}');
  await mkdir(join(sources.controller, 'apps/alpha'), { recursive: true });
  await writeFile(join(sources.controller, 'apps/alpha/artifact.bin'), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(sources.controller, 'apps/alpha/state.json'), 'nested app state');
  await writeFile(join(sources.controller, 'secret.key'), 'private-secret'); await chmod(join(sources.controller, 'secret.key'), 0o600);
  for (const role of dataRoles.filter(role => role !== 'controller')) {
    await mkdir(join(sources[role], 'objects'));
    await writeFile(join(sources[role], 'objects', 'part'), `${role}-bytes`);
  }
  await writeFile(join(volumes.controller, 'state.json'), '{"fresh":true}'); await chmod(join(volumes.controller, 'state.json'), 0o640);
  for (const role of controlRoles) await writeFile(join(volumes[role], 'record'), `${role}-control`);
  const context = { root, bundle, config, policy, sources, volumes, calls: [] };
  await edit(context);
  for (const role of dataRoles) {
    const archive = join(bundle, `${role}.tar`);
    if (!(await lstat(archive).catch(() => null))) tar('--numeric-owner', '-cpf', archive, '-C', sources[role], '.');
  }
  context.readVolume = durableDataTransport(config, policy, volumes, context.calls);
  context.restore = () => restoreDurableData(bundle, config, policy, { readVolume: context.readVolume });
  return context;
}
async function refused(context) {
  const error = await context.restore().then(() => null, error => error);
  assert.equal(error?.code, 'DURABLE_RESTORE_DATA_UNCONFIRMED'); assert.equal(error.cause, undefined);
  for (const leak of [context.root, 'state.json', 'secret', 'slot-', 'private']) assert.equal(error.message.includes(leak), false);
}
const extracted = context => context.calls.filter(([mode]) => mode.startsWith('extract'));

test('restores only data roles beside the identical fresh controller state', { skip }, async t => {
  const context = await fixture(t), state = join(context.volumes.controller, 'state.json');
  const before = await stateIdentity(state), controls = {};
  for (const role of controlRoles) controls[role] = await tree(context.volumes[role]);
  assert.deepEqual(await context.restore(), { roles: dataRoles });
  assert.deepEqual(await stateIdentity(state), before);
  assert.equal(await readFile(state, 'utf8'), '{"fresh":true}');
  const { 'state.json': _, ...restored } = await tree(context.volumes.controller), { 'state.json': __, ...source } = await tree(context.sources.controller);
  assert.deepEqual(restored, source);
  assert.equal(await readFile(join(context.volumes.controller, 'apps/alpha/state.json'), 'utf8'), 'nested app state');
  assert.equal((await lstat(join(context.volumes.controller, 'secret.key'))).mode & 0o777, 0o600);
  for (const role of dataRoles.filter(role => role !== 'controller')) assert.deepEqual(await tree(context.volumes[role]), await tree(context.sources[role]));
  for (const role of controlRoles) assert.deepEqual(await tree(context.volumes[role]), controls[role]);
  assert.deepEqual(context.calls.slice(0, dataRoles.length), dataRoles.map(role => ['survey', role]));
  assert.ok(context.calls.every(([, role]) => dataRoles.includes(role)));
  assert.deepEqual(extracted(context).map(([, role]) => role), dataRoles);
  assert.deepEqual(context.calls.filter(([, role]) => role === 'controller').map(([mode]) => mode), ['survey', 'extract-controller', 'survey', 'compare-controller']);
});

test('refuses nonempty or unexpected targets before any copy', { skip }, async t => {
  const preexisting = [
    async c => writeFile(join(c.volumes['slot-2-b'], 'stale'), 'x'),
    async c => writeFile(join(c.volumes.controller, 'stale'), 'x'),
    async c => { await rm(join(c.volumes.controller, 'state.json')); await symlink('elsewhere', join(c.volumes.controller, 'state.json')); },
    async c => { await rm(join(c.volumes.controller, 'state.json')); },
    async c => link(join(c.volumes.controller, 'state.json'), join(c.root, 'outside-alias')),
  ];
  for (const edit of preexisting) {
    const context = await fixture(t, edit);
    await refused(context);
    assert.deepEqual(extracted(context), []);
    for (const role of dataRoles.filter(role => !['controller', 'slot-2-b'].includes(role))) assert.deepEqual(await readdir(context.volumes[role]), []);
  }
});

test('refuses state aliases and overwrite attempts, retaining extracted data', { skip }, async t => {
  const aliases = {
    hardlink: async c => { await link(join(c.sources.controller, 'state.json'), join(c.sources.controller, 'alias'));
      tar('-cpf', join(c.bundle, 'controller.tar'), '-C', c.sources.controller, './state.json', './alias', './apps'); },
    symlink: async c => symlink('state.json', join(c.sources.controller, 'alias')),
    overwrite: async c => {
      const through = join(c.root, 'through'); await mkdir(join(through, 'via'), { recursive: true });
      await writeFile(join(through, 'via', 'state.json'), 'overwrite'); await symlink('.', join(c.sources.controller, 'via'));
      tar('-cpf', join(c.bundle, 'controller.tar'), '-C', c.sources.controller, '.');
      tar('-rpf', join(c.bundle, 'controller.tar'), '-C', through, './via/state.json');
    },
  };
  for (const [name, edit] of Object.entries(aliases)) {
    const context = await fixture(t, edit), state = join(context.volumes.controller, 'state.json');
    const before = await readFile(state, 'utf8');
    await refused(context);
    assert.equal(await readFile(state, 'utf8'), before, name);
    assert.deepEqual(extracted(context).map(([, role]) => role), ['bucket', 'controller'], name);
    assert.deepEqual(await tree(context.volumes.bucket), await tree(context.sources.bucket), name);
    assert.ok((await readdir(context.volumes.controller)).includes('apps'), name);
    assert.deepEqual(await readdir(context.volumes['slot-1-a']), [], name);
  }
});

test('partial failure retains earlier copies and attempts no cleanup or retry', { skip }, async t => {
  const context = await fixture(t, c => writeFile(join(c.bundle, 'slot-2-a.tar'), 'not an archive'));
  await refused(context);
  assert.deepEqual(extracted(context).map(([, role]) => role), ['bucket', 'controller', 'slot-1-a', 'slot-1-b', 'slot-2-a']);
  for (const role of ['bucket', 'slot-1-a', 'slot-1-b']) assert.deepEqual(await tree(context.volumes[role]), await tree(context.sources[role]));
  assert.deepEqual(await readdir(context.volumes['slot-2-b']), []);
  // Comparison failure after a completed extraction is also retained.
  const mutated = await fixture(t);
  const readVolume = mutated.readVolume;
  mutated.readVolume = async (image, volume, args, options) => {
    if (args[3] === 'compare' && volume === mutated.config.volumes.bucket.name) await writeFile(join(mutated.volumes.bucket, 'objects', 'part'), 'changed');
    return readVolume(image, volume, args, options);
  };
  const error = await restoreDurableData(mutated.bundle, mutated.config, mutated.policy, { readVolume: mutated.readVolume }).then(() => null, error => error);
  assert.equal(error?.code, 'DURABLE_RESTORE_DATA_UNCONFIRMED');
  assert.equal(await readFile(join(mutated.volumes.bucket, 'objects', 'part'), 'utf8'), 'changed');
  assert.deepEqual(extracted(mutated).map(([, role]) => role), ['bucket']);
});

test('refuses unsealed configs and profiles without touching volumes', { skip }, async t => {
  const context = await fixture(t), { config, policy, bundle } = context;
  const tls = structuredClone(config); tls.volumes.tls = { name: `${config.name}_tls` };
  const comma = structuredClone(config); comma.volumes.bucket.name += ',readonly';
  const cases = [[tls, policy], [comma, policy], [config, { ...policy, routing: undefined }], [config, { ...policy, image: 'other:latest' }]];
  for (const [input, profile] of cases) {
    const error = await restoreDurableData(bundle, input, profile, { readVolume: context.readVolume }).then(() => null, error => error);
    assert.equal(error?.code, 'DURABLE_RESTORE_DATA_UNCONFIRMED');
  }
  await rm(join(bundle, 'slot-1-b.tar')); await symlink(join(bundle, 'bucket.tar'), join(bundle, 'slot-1-b.tar'));
  await refused(context);
  assert.deepEqual(context.calls, []);
});
