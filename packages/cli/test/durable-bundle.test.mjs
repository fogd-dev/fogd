import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, link, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { durableSnapshotLayout, verifyDurableBundle } from '../src/recovery/durable-bundle.mjs';
import { backgroundBackupApps } from '../src/recovery/background-backup.mjs';
import { verifyBundle, fingerprint } from '../src/recovery/bundle.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

const schema2 = ({ routing, ...policy }) => ({ ...policy, schema: 2, controllerArgs: ['packages/platform/src/main.mjs'] });
import { durableFixture as durable, durableBundleFixture as bundle, tarArchive as tar } from './fixtures/durable-bundle.mjs';
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
