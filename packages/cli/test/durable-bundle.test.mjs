import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, link, symlink, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { RoutePublication } from '../../platform/src/route-publication.mjs';
import { writeRouteRecord } from '../../platform/src/route-record-store.mjs';
import { durableSnapshotLayout, durableSnapshotFormat, verifyDurableBundle } from '../src/recovery/durable-bundle.mjs';
import { backgroundBackupApps } from '../src/recovery/background-backup.mjs';
import { verifyBundle, fingerprint } from '../src/recovery/bundle.mjs';
import { durableRuntimeConfig } from '../src/runtime/durable-config.mjs';
import { freshRuntimePlan, runtimePolicyForConfig } from '../src/runtime/selection-plan.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

const schema2 = ({ routing, ...policy }) => ({ ...policy, schema: 2, controllerArgs: ['packages/platform/src/main.mjs'] });
const first = '00000000-0000-4000-8000-000000000001', digest = 'b'.repeat(64);
function durable() {
  const { source, profile } = prebootFixture();
  source.services.controller.environment.FOGD_GATEWAY_TOKEN = 'private-gateway';
  const entry = { ...profile, id: 'celld-cron-v2-linux-arm64', admission: 'candidate', routing: 'durable' };
  const legacy = freshRuntimePlan(source, { ...entry, routing: undefined }), policy = runtimePolicyForConfig(legacy.config, entry);
  return { config: durableRuntimeConfig(legacy.config, policy), policy };
}

// Drive the real publisher to a settled withheld or active pair.
async function routePair(root, policy, stage) {
  const authority = join(root, 'authority'); await mkdir(authority); await chmod(authority, 0o755);
  const routes = { installation: runtimePolicyIdentity(policy), slots: policy.fleets.map(fleet => fleet.id) };
  const state = { apps: {}, deployments: {} };
  const publication = new RoutePublication({ state, policy: routes, path: join(authority, 'routes.json'), domain: 'localhost', savePrivate: async () => {},
    writePublic: (path, record) => writeRouteRecord(path, record, routes), createPublic: (path, record) => writeRouteRecord(path, record, routes) });
  await publication.initialize();
  if (stage !== 'empty') {
    state.apps.alpha = { slot: 'slot-1', active: null, route: 'paused' };
    state.deployments[first] = { id: first, app: 'alpha', digest, status: 'activating', step: 'preparing-activation', secretRevision: null };
    await publication.withhold('alpha', first, digest);
  }
  if (stage === 'active') {
    state.apps.alpha.active = first; state.apps.alpha.route = 'active'; Object.assign(state.deployments[first], { status: 'active', step: 'complete' });
    await publication.activate('alpha');
  }
  return { state: structuredClone(state), authority };
}

const tar = (output, directory, ...members) => execFileSync('tar', ['-cf', output, '-C', directory, ...(members.length ? members : ['.'])]);
async function bundle(t, { stage = 'active', edit = () => {} } = {}) {
  const root = await mkdtemp('/tmp/fogd-durable-bundle-'); t.after(() => rm(root, { recursive: true, force: true }));
  const { config, policy } = durable(), { state, authority } = await routePair(root, policy, stage);
  const dir = join(root, 'bundle'), staging = join(root, 'staging'); await mkdir(dir); await mkdir(staging);
  await writeFile(join(staging, 'state.json'), JSON.stringify(state)); tar(join(dir, 'controller.tar'), staging, 'state.json');
  tar(join(dir, 'route-authority.tar'), authority);
  const layout = durableSnapshotLayout(config, policy);
  for (const name of layout.archiveVolumes.filter(name => !['controller', 'route-authority'].includes(name))) tar(join(dir, `${name}.tar`), staging, 'state.json');
  await writeFile(join(dir, 'images.tar'), 'images'); await writeFile(join(dir, 'compose.json'), JSON.stringify(config));
  const context = { root, dir, config, policy, state, authority, layout };
  await edit(context);
  const files = {};
  for (const name of layout.archives) files[name] = await fingerprint(join(dir, name));
  const images = Object.fromEntries(layout.services.map(name => [name, name === 'minio' ? policy.storageImage : policy.image]));
  const revision = stage === 'empty' ? '0' : stage === 'active' ? '2' : '1';
  const sha256 = createHash('sha256').update(await readFile(join(authority, 'routes.json')).catch(() => '')).digest('hex');
  context.manifest = { format: durableSnapshotFormat, sourceProject: config.name, images, files, routeAuthority: { schema: 1, installation: runtimePolicyIdentity(policy), revision, sha256 } };
  return context;
}
const write = context => writeFile(join(context.dir, 'manifest.json'), JSON.stringify(context.manifest));
async function refuses(context, profile = context.policy) {
  await write(context);
  const error = await verifyDurableBundle(context.dir, profile).then(() => null, error => error);
  assert.equal(error?.code, 'DURABLE_BUNDLE_REFUSED');
  assert.equal(error.cause, undefined);
  for (const secret of ['private-', context.root, 'routes.json']) assert.equal(error.message.includes(secret), false);
}

test('layout archives data and public route authority, never execution authority', () => {
  const { config, policy } = durable(), layout = durableSnapshotLayout(config, policy);
  assert.deepEqual(layout.replicas, ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b']);
  assert.deepEqual(layout.services, ['bucket-init', 'controller', 'minio', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b', 'workerd']);
  assert.deepEqual(layout.archiveVolumes, ['bucket', 'controller', 'route-authority', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b']);
  assert.deepEqual(layout.volumes, Object.keys(config.volumes).sort());
  assert.deepEqual(layout.archives, ['bucket.tar', 'compose.json', 'controller.tar', 'images.tar', 'route-authority.tar', 'slot-1-a.tar', 'slot-1-b.tar', 'slot-2-a.tar', 'slot-2-b.tar']);
  for (const role of ['runtime-policy', 'gateway-policy', 'route-enrollment']) assert.ok(layout.volumes.includes(role) && !layout.archives.includes(`${role}.tar`));
  const tls = structuredClone(config); tls.volumes.tls = { name: `${config.name}_tls` };
  assert.throws(() => durableSnapshotLayout(tls, policy));
  assert.throws(() => durableSnapshotLayout(config, schema2(policy)));
  const legacy = prebootFixture();
  assert.throws(() => durableSnapshotLayout(legacy.source, policy));
});

test('verifies settled withheld and active pairs through the shared route validator', async t => {
  for (const stage of ['empty', 'withheld', 'active']) {
    const context = await bundle(t, { stage }); await write(context);
    const result = await verifyDurableBundle(context.dir, context.policy);
    assert.deepEqual(result.manifest, context.manifest); assert.deepEqual(result.config, context.config); assert.deepEqual(result.state, context.state);
    assert.equal(result.authority.digest, context.manifest.routeAuthority.sha256);
    assert.equal(result.authority.record.routes.length, stage === 'empty' ? 0 : 1);
  }
});

test('refuses changed files and inexact archive inventory', async t => {
  const changed = await bundle(t); await write(changed); await writeFile(join(changed.dir, 'bucket.tar'), 'changed'); await refuses(changed);
  const excess = await bundle(t, { edit: c => writeFile(join(c.dir, 'gateway-policy.tar'), 'policy') });
  excess.manifest.files['gateway-policy.tar'] = await fingerprint(join(excess.dir, 'gateway-policy.tar')); await refuses(excess);
  const missing = await bundle(t); delete missing.manifest.files['route-authority.tar']; await refuses(missing);
  const renamed = await bundle(t); renamed.manifest.files['runtime-policy.tar'] = renamed.manifest.files['bucket.tar']; delete renamed.manifest.files['bucket.tar']; await refuses(renamed);
  const legacyFormat = await bundle(t); legacyFormat.manifest.format = 'fogd-stopped-v1'; await refuses(legacyFormat);
  const project = await bundle(t); project.manifest.sourceProject = 'other'; await refuses(project);
  const images = await bundle(t); images.manifest.images.minio = images.policy.image; await refuses(images);
  const extraImage = await bundle(t); extraImage.manifest.images.extra = extraImage.policy.image; await refuses(extraImage);
  const unsealed = await bundle(t, { edit: c => { c.config.services.workerd.volumes[1].read_only = false; return writeFile(join(c.dir, 'compose.json'), JSON.stringify(c.config)); } });
  await refuses(unsealed);
});

test('refuses independent profile mismatch and never adopts manifest policy', async t => {
  const context = await bundle(t);
  await refuses(context, { ...context.policy, image: 'sha256:' + 'e'.repeat(64) });
  await refuses(context, schema2(context.policy));
  const fleets = structuredClone(context.policy.fleets); fleets[0].nodes[0].id = 'other-node';
  await refuses(context, { ...context.policy, fleets });
  const adopted = await bundle(t); adopted.manifest.profile = { ...adopted.policy, image: 'sha256:' + 'e'.repeat(64) };
  await write(adopted); await verifyDurableBundle(adopted.dir, adopted.policy);
  await refuses(adopted, adopted.manifest.profile);
});

test('refuses malformed, ambiguous and inconsistent public route members', async t => {
  const reroute = edit => bundle(t, { edit: async c => { await edit(c); await rm(join(c.dir, 'route-authority.tar')); tar(join(c.dir, 'route-authority.tar'), c.authority, ...(c.members || ['.'])); } });
  const compact = await reroute(async c => writeFile(join(c.authority, 'routes.json'), JSON.stringify(JSON.parse((await readFile(join(c.authority, 'routes.json'), 'utf8')))))); await refuses(compact);
  const newline = await reroute(async c => writeFile(join(c.authority, 'routes.json'), (await readFile(join(c.authority, 'routes.json'), 'utf8')) + '\n')); await refuses(newline);
  const unicode = await reroute(async c => writeFile(join(c.authority, 'routes.json'), (await readFile(join(c.authority, 'routes.json'), 'utf8')).replace('"routes"', '"röutes"'))); await refuses(unicode);
  const garbage = await reroute(async c => writeFile(join(c.authority, 'routes.json'), 'not json')); await refuses(garbage);
  const large = await reroute(async c => writeFile(join(c.authority, 'routes.json'), ' '.repeat(70000))); await refuses(large);
  const absent = await reroute(async c => rm(join(c.authority, 'routes.json'))); await refuses(absent);
  const nested = await reroute(async c => { await mkdir(join(c.authority, 'x')); c.members = ['./routes.json', 'x/../routes.json']; }); await refuses(nested);
  const duplicate = await reroute(async c => { c.members = ['routes.json', './routes.json']; }); await refuses(duplicate);
  const revision = await bundle(t); revision.manifest.routeAuthority.revision = '1'; await refuses(revision);
  const extra = await bundle(t); extra.manifest.routeAuthority.extra = true; await refuses(extra);
  // An active public record paired with withheld private state is inconsistent.
  const other = await bundle(t, { stage: 'withheld' }), active = await bundle(t);
  await rm(join(other.dir, 'route-authority.tar')); tar(join(other.dir, 'route-authority.tar'), active.authority);
  other.manifest.files['route-authority.tar'] = await fingerprint(join(other.dir, 'route-authority.tar')); other.manifest.routeAuthority = active.manifest.routeAuthority;
  await refuses(other);
});

test('legacy restore refuses the durable format until it is integrated', async t => {
  const context = await bundle(t); await write(context);
  await assert.rejects(verifyBundle(context.dir), /unsupported backup manifest/);
});

test('public authority must be an archived regular file rather than a link to another member', async t => {
  for (const kind of ['hard', 'symbolic']) {
    const context = await bundle(t, { edit: async c => {
      await rename(join(c.authority, 'routes.json'), join(c.authority, 'other.json'));
      if (kind === 'hard') await link(join(c.authority, 'other.json'), join(c.authority, 'routes.json'));
      else await symlink('other.json', join(c.authority, 'routes.json'));
      await rm(join(c.dir, 'route-authority.tar'));
      tar(join(c.dir, 'route-authority.tar'), c.authority, 'other.json', 'routes.json');
    } });
    await refuses(context);
  }
});

test('only a validated schema 3 durable profile admits route authority state', async () => {
  const { policy } = durable(), state = { apps: {}, deployments: {}, requirements: ['fogd-route-authority-v1'] };
  const legacy = schema2(policy);
  assert.throws(() => backgroundBackupApps(state), /unsupported recovery capability/);
  assert.throws(() => backgroundBackupApps(state, legacy), /unsupported recovery capability/);
  assert.throws(() => backgroundBackupApps(state, { ...policy, image: 'invalid' }), { code: 'RUNTIME_POLICY_REFUSED' });
  assert.deepEqual(backgroundBackupApps(state, policy), { queueRecovery: [], cronRecovery: [] });
  assert.throws(() => backgroundBackupApps({ ...state, requirements: ['fogd-route-authority-v1', 'fogd-unknown-v1'] }, policy), /unsupported recovery capability/);
  assert.deepEqual(backgroundBackupApps({ apps: {}, deployments: {} }), { queueRecovery: [], cronRecovery: [] });
});
