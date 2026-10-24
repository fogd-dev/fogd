import { mkdir, writeFile, readFile, readdir, rm, lstat, chown, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { artifactDigest } from '@fogd/runtime/artifact';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { Controller } from '../../../platform/src/controller.mjs';
import { initializeFreshRouteStores } from '../../../platform/src/fresh-route-enrollment.mjs';
import { readRouteRecord } from '../../../platform/src/route-record-store.mjs';
import { planArtifactRetention } from '../../../platform/src/artifact-retention.mjs';
import { validateRouteSnapshot } from '../../../platform/src/route-snapshot.mjs';
import { fingerprint } from '../../src/recovery/bundle.mjs';
import { durableBundleFixture } from './durable-bundle.mjs';
import { gnuTar } from './durable-data-transport.mjs';

async function hostOwnership(path) {
  await chown(path, process.getuid(), process.getgid());
  if ((await lstat(path)).isDirectory()) for (const name of await readdir(path)) await hostOwnership(join(path, name));
}
export async function sourceBundle(t, apps = ['alpha']) {
  const f = await durableBundleFixture(t, { stage: 'empty' }), roots = {};
  for (const role of ['controller', 'authority', 'enrollment']) { roots[role] = join(f.root, `source-${role}`); await mkdir(roots[role]); }
  await initializeFreshRouteStores({ profile: f.policy, binding: 'a'.repeat(64) }, roots);
  const slots = f.policy.fleets.map(fleet => ({ ...fleet, nodes: fleet.nodes.map(node => node.host) })), owners = {};
  const policy = { installation: runtimePolicyIdentity(f.policy), slots: slots.map(slot => slot.id) };
  const backend = { owner: async slot => owners[slot.id] || null, hasDeployment: async () => false, assertUnclaimed: async () => {},
    claim: async (slot, app) => { owners[slot.id] = { app }; }, publish: async () => randomUUID(), ready: async () => {}, applicationReady: async () => {}, migrate: async () => {}, applied: async () => [] };
  const c = new Controller({ dir: roots.controller, slots, backend, routeAuthority: { path: join(roots.authority, 'routes.json'), policy, verifyRuntime: async () => {} } });
  await c.init();
  async function approve(app) {
    const id = randomUUID(), artifact = c.artifact(id); await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, 'index.js'), 'export default {fetch(){return new Response("saved")}}');
    await writeFile(join(artifact, 'wrangler.json'), JSON.stringify({ name: app, main: 'index.js', d1_databases: [] }));
    const request = { id, app, digest: await artifactDigest(artifact), resources: { script: app, d1: [], r2: [], durable: { bindings: [] } }, migrations: [], requiredSecrets: [], status: 'pending', step: 'submitted' };
    c.state.deployments[id] = request; await c.save(); await c.mutate(id, request.digest, 'approve');
    await c.setArtifactPin(id, request.digest, true);
    return request;
  }
  const requests = {};
  for (const app of apps) requests[app] = await approve(app);
  const request = requests[apps[0]], artifact = c.artifact(request.id);
  const retiredId = randomUUID(); await cp(artifact, c.artifact(retiredId), { recursive: true });
  c.state.deployments[retiredId] = { ...request, id: retiredId, status: 'rejected' }; await c.save();
  const retention = await planArtifactRetention(c.state, join(c.dir, 'artifacts'));
  const pruneReceipt = await c.pruneArtifacts(retention.plan);
  await writeFile(join(roots.controller, 'operator-secret.key'), 'source-private-value', { mode: 0o600 });
  // Use the actual producer's GNU tar flags, with ownership matching the host
  // helper identity. Native root ownership is a separate acceptance gate.
  for (const role of f.layout.archiveVolumes) {
    const path = role === 'controller' ? roots.controller : role === 'route-authority' ? roots.authority : join(f.root, 'staging');
    await hostOwnership(path);
    await rm(join(f.dir, `${role}.tar`)); execFileSync(gnuTar, ['--numeric-owner', '-cpf', join(f.dir, `${role}.tar`), '-C', path, '.']);
    f.manifest.files[`${role}.tar`] = await fingerprint(join(f.dir, `${role}.tar`));
  }
  const observed = await readRouteRecord(join(roots.authority, 'routes.json'), policy);
  f.manifest.routeAuthority = validateRouteSnapshot(c.state, observed, f.policy);
  await writeFile(join(f.dir, 'manifest.json'), JSON.stringify(f.manifest));
  return { ...f, c, owners, slots, routePolicy: policy, roots, request, requests, pruneReceipt };
}
