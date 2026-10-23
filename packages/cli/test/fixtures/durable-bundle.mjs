import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { RoutePublication } from '../../../platform/src/route-publication.mjs';
import { writeRouteRecord } from '../../../platform/src/route-record-store.mjs';
import { durableSnapshotLayout, durableSnapshotFormat } from '../../src/recovery/durable-bundle.mjs';
import { fingerprint } from '../../src/recovery/bundle.mjs';
import { durableRuntimeConfig } from '../../src/runtime/durable-config.mjs';
import { freshRuntimePlan, runtimePolicyForConfig } from '../../src/runtime/selection-plan.mjs';
import { prebootFixture } from './cron-preboot.mjs';

const first = '00000000-0000-4000-8000-000000000001', digest = 'b'.repeat(64);
export function durableFixture() {
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

export const tarArchive = (output, directory, ...members) => execFileSync('tar', ['-cf', output, '-C', directory, ...(members.length ? members : ['.'])]);
export async function durableBundleFixture(t, { stage = 'active', edit = () => {} } = {}) {
  const root = await mkdtemp('/tmp/fogd-durable-bundle-'); t.after(() => rm(root, { recursive: true, force: true }));
  const { config, policy } = durableFixture(), { state, authority } = await routePair(root, policy, stage);
  const dir = join(root, 'bundle'), staging = join(root, 'staging'); await mkdir(dir); await mkdir(staging);
  await writeFile(join(staging, 'state.json'), JSON.stringify(state)); tarArchive(join(dir, 'controller.tar'), staging, 'state.json');
  tarArchive(join(dir, 'route-authority.tar'), authority);
  const layout = durableSnapshotLayout(config, policy);
  for (const name of layout.archiveVolumes.filter(name => !['controller', 'route-authority'].includes(name))) tarArchive(join(dir, `${name}.tar`), staging, 'state.json');
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
