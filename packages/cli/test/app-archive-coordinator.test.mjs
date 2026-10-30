import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { readRuntimePolicy } from '../../platform/src/runtime-policy-file.mjs';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { readAppArchivePlan, readAppArchiveRestorationPlan } from '../src/runtime/app-archive-plan.mjs';
import { archiveDurableInstallation, restoreArchivedInstallation } from '../src/recovery/durable-restore.mjs';
import { restoreDurableData } from '../src/recovery/durable-restore-data.mjs';
import { restoreAppArchiveData } from '../src/recovery/app-archive-data.mjs';
import { archiveDurableRoutes, restoreArchivedDurableRoutes } from '../src/runtime/durable-restoration.mjs';
import { enrollDurableRestoration } from '../src/runtime/durable-installation.mjs';
import { assertDurableEnrollmentReady } from '../src/runtime/enrollment-record.mjs';
import { acquireStopFence } from '../src/runtime/launch-fence.mjs';
import { archiveDataFixture, generation, records } from './fixtures/app-archive-data.mjs';
import { durableEnrollmentFixture } from './fixtures/durable-enrollment.mjs';
import { durableDataTransport } from './fixtures/durable-data-transport.mjs';

async function fixture(t, operation = 'restore') {
  const f = await archiveDataFixture(t), p = f.selection.currentProfile;
  const entry = { ...runtimeFamilies()[0], schema: 2, routing: 'durable', id: p.family, admission: p.admission,
    image: p.image, storageImage: p.storageImage, binarySha256: p.binarySha256, supervisorSha256: p.supervisorSha256 };
  entry.sourceFiles['packages/platform/src/import-app-archive-routes.mjs'] = 'a'.repeat(64);
  const choose = { choose: () => entry }, project = 'fogd-archive-coordinator-target';
  const selection = { expectedIdentity: runtimePolicyIdentity(p), retainedIdentity: runtimePolicyIdentity(f.selection.retainedProfile) };
  const restore = { archive: generation, expectedIdentity: f.selection.expectedIdentity, slot: 'slot-2' };
  const archive = { app: 'alpha', digest: f.request.digest, id: '30000000-0000-4000-8000-000000000003', at: '2026-10-30T03:00:00.000Z' };
  const directory = operation === 'restore' ? f.currentDir : f.retainedDir;
  if (operation === 'archive') selection.expectedIdentity = selection.retainedIdentity;
  const planReader = (directory, project, selected) => operation === 'restore'
    ? readAppArchiveRestorationPlan(directory, f.retainedDir, project, selected, restore, choose)
    : readAppArchivePlan(directory, project, selected, archive, choose);
  const plan = await planReader(directory, project, selection), target = await durableEnrollmentFixture(t, { ...plan.target, entry });
  const paths = Object.fromEntries(Object.keys(plan.target.config.volumes).map(role => [role, target.rolePath(role)]));
  const transport = durableDataTransport(plan.target.config, plan.target.policy, paths), hosts = {}, events = [];
  for (const source of plan.sources) { hosts[source.config.name] = join(f.root, 'host-'+source.config.name); await mkdir(hosts[source.config.name], { mode: 0o700 }); }
  let live = null;
  const options = {
    plan: planReader, verify: async () => {}, enrolled: async () => true, directory: name => hosts[name],
    acquire: async (directory, identity) => { events.push(['fence', identity.project]); return acquireStopFence(directory, identity); },
    related: async () => {}, operationPeers: async () => {}, stopped: async name => { events.push(['stopped', name]); if (name === live) throw Error('owned source writer'); },
    relation: async (project, sourceProject, config) => { events.push(['relation', sourceProject]); await writeFile(join(target.directory, 'recovery-source.json'), JSON.stringify({ schema: 1, project, sourceProject, volumes: Object.values(config.volumes).map(v => v.name) })); },
    relations: async (project, sources) => { events.push(['relations', ...sources.map(source => source.project)]); await writeFile(join(target.directory, 'recovery-source.json'), JSON.stringify({ schema: 2, project, sources: sources.map(source => ({ sourceProject: source.project, volumes: Object.values(source.config.volumes).map(v => v.name) })) })); },
    enroll: (selected, tasks) => enrollDurableRestoration(selected, tasks, target.options),
    data: (directory, config, policy, opts, plan) => operation === 'restore'
      ? restoreAppArchiveData(directory, f.retainedDir, config, plan.dataSelection, { readVolume: transport })
      : restoreDurableData(directory, config, policy, { ...opts, readVolume: transport }),
    routes: (config, input) => operation === 'restore' ? restoreArchivedDurableRoutes(config, input, { run: target.options.run }) : archiveDurableRoutes(config, input, { run: target.options.run }),
    policy: (_image, _volume, env) => readRuntimePolicy(target.rolePath('runtime-policy'), env),
  };
  const output = join(f.root, 'coordinator-output');
  const run = () => operation === 'restore'
    ? restoreArchivedInstallation(directory, f.retainedDir, project, output, selection, restore, options)
    : archiveDurableInstallation(directory, project, output, selection, archive, options);
  return { ...f, plan, planReader, target, selection, restore, archive, entry, hosts, events, options, output, directory, project, run, paths,
    sourceLive: project => { live = project; } };
}
const uncertain = { code: 'DURABLE_RESTORE_UNCONFIRMED' };

test('stopped archive restoration completes held enrollment with both sources fenced and current peer SQL preserved', async t => {
  const f = await fixture(t); await f.run();
  await assertDurableEnrollmentReady(f.target.directory);
  const state = JSON.parse(await readFile(join(f.paths.controller, 'state.json')));
  assert.equal(state.apps.alpha.archiveRecovery.status, 'pending'); assert.equal(state.apps.alpha.route, 'paused');
  assert.equal(state.apps.beta.route, 'paused');
  assert.deepEqual(records(join(f.paths['slot-2-a'], 'records.sqlite')), ['alpha-before-archive']);
  assert.deepEqual(records(join(f.paths['slot-1-a'], 'records.sqlite')), ['beta-after-archive']);
  assert.deepEqual(f.events.filter(event => event[0] === 'fence').map(event => event[1]), [...Object.keys(f.hosts)].sort());
  const relation = JSON.parse(await readFile(join(f.target.directory, 'recovery-source.json')));
  assert.equal(relation.schema, 2); assert.equal(relation.sources.length, 2);
  const receipt = JSON.parse(await readFile(join(f.output, 'app-archive.json')));
  assert.equal(receipt.archive.identity, f.restore.expectedIdentity); assert.equal(receipt.sources.length, 2);
  assert.equal(receipt.services, 'stopped');
  await assert.rejects(lstat(join(f.hosts[f.plan.source.config.name], 'launch.pending.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.hosts[f.plan.retained.config.name], 'launch.pending.json')), { code: 'ENOENT' });
});
test('archiving completes stopped enrollment with a reserved name and empty fresh generation disks', async t => {
  const f = await fixture(t, 'archive'); await f.run();
  await assertDurableEnrollmentReady(f.target.directory);
  const state = JSON.parse(await readFile(join(f.paths.controller, 'state.json')));
  assert.equal(state.apps.alpha.route, 'archived'); assert.equal(state.apps.alpha.slot, null);
  assert.deepEqual(await readdir(f.paths['slot-1-a']), []); assert.deepEqual(await readdir(f.paths['slot-1-b']), []);
  assert.equal(JSON.parse(await readFile(join(f.output, 'app-archive.json'))).operation, 'archive');
});
test('a live retained source refuses before fences, target allocation or output', async t => {
  const f = await fixture(t); f.sourceLive(f.plan.retained.config.name);
  await assert.rejects(f.run(), uncertain);
  assert.deepEqual(f.target.events, []); assert.deepEqual(f.events.filter(event => event[0] === 'fence'), []);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});
test('failure acquiring the second source fence releases the first without allocating a target', async t => {
  const f = await fixture(t), names = Object.keys(f.hosts).sort();
  const blocking = await acquireStopFence(f.hosts[names[1]], { project: names[1], installation: 'f'.repeat(64) });
  await assert.rejects(f.run(), uncertain);
  assert.deepEqual(f.target.events, []); await assert.rejects(lstat(join(f.hosts[names[0]], 'launch.pending.json')), { code: 'ENOENT' });
  assert.equal((await lstat(join(f.hosts[names[1]], 'launch.pending.json'))).isFile(), true);
  await blocking.release();
});
test('a pending sibling operation discovered after source fencing refuses before target allocation', async t => {
  const f = await fixture(t), owned = Object.keys(f.hosts).sort();
  f.options.operationPeers = async (_project, held) => {
    if (held.length) { assert.deepEqual(held, owned); throw Error('Owned sibling operation in progress'); }
  };
  await assert.rejects(f.run(), uncertain);
  assert.deepEqual(f.target.events, []);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.hosts[owned[0]], 'launch.pending.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.hosts[owned[1]], 'launch.pending.json')), { code: 'ENOENT' });
});
test('a failed two-source relation leaves pending enrollment and never creates target resources', async t => {
  const f = await fixture(t); f.options.relations = async () => { throw Error('owned relation persistence failure'); };
  await assert.rejects(f.run(), uncertain);
  assert.deepEqual(f.target.events, []); await assert.rejects(assertDurableEnrollmentReady(f.target.directory));
});
test('output inside the retained snapshot refuses before source fencing or Docker', async t => {
  const f = await fixture(t);
  await assert.rejects(restoreArchivedInstallation(f.directory, f.retainedDir, f.project, join(f.retainedDir, 'bad-output'), f.selection, f.restore, f.options), uncertain);
  assert.deepEqual(f.target.events, []); assert.deepEqual(f.events.filter(event => event[0] === 'fence'), []);
  await assert.rejects(lstat(join(f.retainedDir, 'bad-output')), { code: 'ENOENT' });
});
test('a retained writer appearing after data copy keeps enrollment incomplete and route authority fresh', async t => {
  const f = await fixture(t), data = f.options.data;
  f.options.data = async (...args) => { const result = await data(...args); f.sourceLive(f.plan.retained.config.name); return result; };
  await assert.rejects(f.run(), uncertain);
  await assert.rejects(assertDurableEnrollmentReady(f.target.directory));
  assert.deepEqual(JSON.parse(await readFile(join(f.paths.controller, 'state.json'))).apps, {});
  assert.deepEqual(records(join(f.paths['slot-1-a'], 'records.sqlite')), ['beta-after-archive']);
});
test('a retained snapshot changed during route finalization refuses host completion', async t => {
  const f = await fixture(t), routes = f.options.routes;
  f.options.routes = async (...args) => {
    const result = await routes(...args), path = join(f.retainedDir, 'manifest.json'); await writeFile(path, await readFile(path, 'utf8')+'\n'); return result;
  };
  await assert.rejects(f.run(), uncertain);
  await assert.rejects(assertDurableEnrollmentReady(f.target.directory));
  assert.equal(JSON.parse(await readFile(join(f.paths.controller, 'state.json'))).apps.alpha.archiveRecovery.status, 'pending');
  assert.deepEqual(records(join(f.paths['slot-2-a'], 'records.sqlite')), ['alpha-before-archive']);
});
test('a lost source fence release reply still attempts each release once and returns unconfirmed', async t => {
  const f = await fixture(t), acquire = f.options.acquire, releases = [];
  f.options.acquire = async (directory, identity) => {
    const fence = await acquire(directory, identity);
    return { release: async () => { releases.push(identity.project); await fence.release(); if (identity.project === f.plan.source.config.name) throw Error('owned lost release reply'); } };
  };
  await assert.rejects(f.run(), uncertain);
  await assertDurableEnrollmentReady(f.target.directory);
  assert.deepEqual(releases.sort(), Object.keys(f.hosts).sort());
  await assert.rejects(lstat(join(f.hosts[f.plan.source.config.name], 'launch.pending.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(f.hosts[f.plan.retained.config.name], 'launch.pending.json')), { code: 'ENOENT' });
});
test('a source snapshot changed during final policy readback prevents enrollment completion', async t => {
  const f = await fixture(t), policy = f.options.policy;
  f.options.policy = async (...args) => {
    const result = await policy(...args), path = join(f.retainedDir, 'manifest.json'); await writeFile(path, await readFile(path, 'utf8')+'\n'); return result;
  };
  await assert.rejects(f.run(), uncertain);
  await assert.rejects(assertDurableEnrollmentReady(f.target.directory));
});
test('a wrong independently supplied retained identity refuses before source fences or target allocation', async t => {
  const f = await fixture(t); f.selection.retainedIdentity = '0'.repeat(64);
  await assert.rejects(f.run(), uncertain);
  assert.deepEqual(f.target.events, []); assert.deepEqual(f.events, []);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});
test('a selected runtime without the archive helper refuses before any source fence or target allocation', async t => {
  const f = await fixture(t); delete f.entry.sourceFiles['packages/platform/src/import-app-archive-routes.mjs'];
  await assert.rejects(f.run(), uncertain);
  assert.deepEqual(f.target.events, []); assert.deepEqual(f.events, []);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});
