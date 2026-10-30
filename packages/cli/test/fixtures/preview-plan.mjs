import { randomUUID } from 'node:crypto';
import { hash, jsonBytes } from '../../src/build-cache/paths.mjs';
import { createPreviewExecutionAuthority, previewExecutionSha256 } from '../../src/preview/execution-authority.mjs';
import { issuePreviewExecution } from '../../src/preview/execution.mjs';
import { createPreviewPlan, previewPlanTarget } from '../../src/preview/plan.mjs';
import { previewContainerCommands } from '../../src/preview/container-plan.mjs';

export function previewPlanFixture(octet = 250, port = 49443) {
  const id = randomUUID(), authority = createPreviewExecutionAuthority(), storagePassword = 'b'.repeat(64), gatewayToken = 'c'.repeat(64);
  const preparation = { schema: 1, kind: 'fogd-preview-preparation', id, status: 'prepared', preparedAt: new Date().toISOString(),
    source: { controller: 'https://source.test', app: 'demo', submission: randomUUID(), digest: '1'.repeat(64), reviewSha256: '2'.repeat(64) },
    runtime: { family: 'preview-candidate-test', catalogEntrySha256: '3'.repeat(64) },
    policy: { lifetimeSeconds: 60, storage: 'fresh-empty-only', secrets: 'preview-only', requiredSecrets: [], background: 'disabled', network: 'no-external-egress', access: 'owner-authenticated', expiry: 'deny-requests-and-stop-writers', dataPromotion: 'none' },
    executionAuthorized: false, capacityReserved: false, scope: 'Owned plan fixture only' };
  const request = { preparation, preparationSha256: hash(jsonBytes(preparation)), engineId: 'engine-fixture', image: 'sha256:' + '4'.repeat(64), origin: `https://demo.${id.replaceAll('-', '')}.preview.test:${port}`,
    subnets: { control: `10.${octet}.1.0/24`, 'fleet-1': `10.${octet}.2.0/24`, 'fleet-2': `10.${octet}.3.0/24`, frontend: `10.${octet}.4.0/24` },
    fingerprints: { authorityPublicKey: hash(authority.publicKey), artifact: '5'.repeat(64), previewSecrets: hash(jsonBytes({})), storagePassword: hash(storagePassword), gatewayToken: hash(gatewayToken), viewerAccessKey: '6'.repeat(64), gatewayTLS: '7'.repeat(64), ingressTLS: '8'.repeat(64) } };
  const plan = createPreviewPlan(request), target = previewPlanTarget(plan);
  const release = { app: 'demo', digest: preparation.source.digest, requiredSecrets: [], resources: { script: 'demo', durable: { bindings: [] }, d1: [], r2: [] } };
  const envelope = issuePreviewExecution(preparation, { expectedPreparationSha256: request.preparationSha256, release, target, privateKey: authority.privateKey });
  return { plan, request, envelope, authority, storagePassword, gatewayToken,
    commands: (role, secretValues = {}) => previewContainerCommands(plan, envelope, { role, secretValues, publicKey: authority.publicKey, expectedGrantSha256: previewExecutionSha256(envelope) }) };
}
