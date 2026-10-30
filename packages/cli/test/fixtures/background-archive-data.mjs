import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture as queued } from '../../../platform/test/fixtures/queue-controller.mjs';
import { fixture as scheduled } from '../../../platform/test/fixtures/cron-controller.mjs';
import { operateDelivery } from '../../../platform/src/admin-delivery.mjs';
import { operateDispatch } from '../../../platform/src/admin-dispatch.mjs';
import { readRouteRecord } from '../../../platform/src/route-record-store.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { durableBundleFixture } from './durable-bundle.mjs';
import { packRole, saveManifest } from './app-archive-data.mjs';

const families = {
  queue: { fixture: queued, operate: operateDelivery, field: 'queueSnapshot', evidence: 'queueRecovery' },
  cron: { fixture: scheduled, operate: operateDispatch, field: 'cronSnapshot', evidence: 'cronRecovery' },
};
export async function backgroundArchiveSource(t, name) {
  const bundle = await durableBundleFixture(t, { stage: 'empty' }), family = families[name];
  const authority = join(bundle.root, 'background-authority'); await mkdir(authority);
  const policy = { installation: runtimePolicyIdentity(bundle.policy), slots: bundle.policy.fleets.map(fleet => fleet.id) };
  const slots = bundle.policy.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  const fixture = await family.fixture(t, { slots, routeAuthority: { path: join(authority, 'routes.json'), policy, verifyRuntime: async () => {} } });
  const request = await fixture.request(); await fixture.c.mutate(request.id, request.digest, 'approve');
  if (name === 'queue') fixture.backend.queues.snapshot = async () => ({ paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: Date.now() - 1000 });
  await family.operate(fixture.c, request.app, 'snapshot', { deployment: request.id, digest: request.digest });
  const receipt = fixture.c.state.apps[request.app][family.field];
  bundle.manifest[family.evidence] = { schema: 1, apps: { [request.app]: receipt } };
  const observed = await readRouteRecord(join(authority, 'routes.json'), policy);
  bundle.manifest.routeAuthority = { schema: 1, installation: policy.installation, revision: observed.record.revision, sha256: observed.digest };
  await packRole(bundle.dir, 'controller', fixture.c.dir); await packRole(bundle.dir, 'route-authority', authority);
  await saveManifest(bundle.dir, bundle.manifest);
  return { ...bundle, c: fixture.c, request, roots: { controller: fixture.c.dir, authority } };
}
