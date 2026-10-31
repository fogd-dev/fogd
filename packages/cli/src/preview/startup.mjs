import { openPreviewStartup } from './startup-inspection.mjs';
import { bindPreviewRuntime, verifyPreviewRuntime } from './runtime-catalog.mjs';
import { previewServiceCommands } from './container-plan.mjs';
import { assertCurrentPreviewSource } from './decision.mjs';
import { assessPreviewMemory } from './admission.mjs';
import { appendHostRecord, hostRefusal } from './host-records.mjs';
import { guardPreviewHost } from './host-registry.mjs';
import { awaitPreviewReady } from './readiness.mjs';

export const previewShutdownLeadMs = 30000;
const groups = { storage: ['minio'], initialization: ['bucket-init'], natives: ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'],
  controller: ['controller'], gateway: ['gateway'], ingress: ['ingress'] };

function assertProgress(actual, started) {
  for (const [role, container] of Object.entries(actual)) {
    const state = container.State;
    const finished = role === 'input-installer' || role === 'bucket-init' && started.has(role);
    if (finished ? state.Status !== 'exited' || state.ExitCode !== 0 : started.has(role) ? !state.Running : state.Status !== 'created') hostRefusal('startup-exited');
  }
}

function startupClock(input, value, shutdownAt) {
  previewServiceCommands(value.plan, input.envelope, input, input.allocationId);
  if (input.signal?.aborted || Date.now() >= shutdownAt) hostRefusal('startup-window');
}

// Explicit candidate enrollment is for owned qualification. Ordinary catalog
// admission remains closed until the complete preview lifecycle is qualified.
export async function startPreviewAllocation(input) {
  return guardPreviewHost(async () => {
    if (input.plan?.schema !== 3 || input.plan.request.storage?.storage?.schema !== 2) hostRefusal('resource-policy');
    if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) hostRefusal('startup-target');
    if (input.signal?.aborted) hostRefusal('startup-window');
    const runtime = bindPreviewRuntime(input.plan, input.runtime, input.candidateEnrollment);
    const value = await openPreviewStartup(input), shutdownAt = Date.parse(value.snapshot.grant.expiresAt) - previewShutdownLeadMs;
    value.bundle = JSON.parse(value.snapshot.bytes);
    const live = () => startupClock(input, value, shutdownAt);
    let verified;
    try {
      live();
      if (shutdownAt - Date.now() < 15000) hostRefusal('startup-window');
      verified = await verifyPreviewRuntime(runtime, value.complete.identities.containers['input-installer'], input.run);
      await assertCurrentPreviewSource(value.inputs, input.env); live();
      const { observed } = await value.observe(); live();
      assessPreviewMemory(value.plan, observed, value.host.heldRecords.filter(record => record !== value.held).map(record => record.plan));
    } catch (error) { await value.host.fence.release(); throw error; }
    const pending = { schema: 1, kind: 'fogd-preview-startup', allocationId: input.allocationId, reservation: input.reservation,
      planSha256: value.inspection.planSha256, grantSha256: input.expectedGrantSha256, inventorySha256: value.complete.inventorySha256,
      packageSha256: value.snapshot.sha256, runtime: verified, expiresAt: value.snapshot.grant.expiresAt, shutdownAt: new Date(shutdownAt).toISOString() };
    await value.host.fence.record('writing'); await appendHostRecord(value.bound, 'startup.pending.json', pending);
    const started = new Set();
    for (const [phase, roles] of Object.entries(groups)) {
      live(); assertProgress((await value.observe('operating')).roles, started); live();
      await input.run(['start', ...roles.map(role => value.complete.identities.containers[role])]);
      if (phase === 'initialization') {
        if ((await input.run(['wait', value.complete.identities.containers['bucket-init']])).trim() !== '0') hostRefusal('startup-initialization');
      } else for (const role of roles) await awaitPreviewReady(value, role, input.run, live);
      live(); const { roles: actual } = await value.observe('operating');
      roles.forEach(role => started.add(role)); assertProgress(actual, started);
      await appendHostRecord(value.bound, `startup.${phase}.json`, { schema: 1, phase, ready: Object.fromEntries(roles.map(role => [role, actual[role].Id])), observedAt: new Date(Date.now()).toISOString() });
    }
    const complete = { ...pending, readyAt: new Date(Date.now()).toISOString(), ordinaryEnrollment: runtime.admission === 'qualified', resourcesRetained: true };
    await appendHostRecord(value.bound, 'startup.complete.json', complete); await value.host.fence.record('complete'); await value.host.fence.release();
    return { started: true, allocationId: input.allocationId, origin: value.plan.request.origin, expiresAt: complete.expiresAt, shutdownAt: complete.shutdownAt,
      runtime: verified, ordinaryEnrollment: complete.ordinaryEnrollment, capacityReserved: true };
  });
}
