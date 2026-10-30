import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, digest } from '../build-cache/paths.mjs';
import { executionKeys, executionTarget } from './execution-shape.mjs';
import { validatePreviewPreparation } from './execution.mjs';
import { previewNetworks } from './networks.mjs';

const networkRoles = ['control', 'fleet-1', 'fleet-2', 'frontend'];
const fingerprints = ['authorityPublicKey', 'artifact', 'previewSecrets', 'storagePassword', 'gatewayToken', 'viewerAccessKey', 'gatewayTLS', 'ingressTLS'];
const dataRoles = ['minio', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b', 'controller'];
const authorityRoles = ['controller', 'gateway', 'ingress'];
const mib = 1024 ** 2;
export class PreviewPlanError extends Error {
  constructor() { super('Preview plan is invalid or differs from its sealed configuration'); this.code = 'PREVIEW_PLAN_REFUSED'; }
}

function assertOrigin(input, preview, origin) {
  if (!origin.hostname.startsWith(`${input.preparation.source.app}.${preview}.`) || origin.hostname.length > 253 ||
    !origin.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || Number(origin.port || 443) < 1) throw new PreviewPlanError();
}

function checkedRequest(input) {
  executionKeys(input, ['preparation', 'preparationSha256', 'engineId', 'image', 'origin', 'subnets', 'fingerprints']);
  validatePreviewPreparation(input.preparation, input.preparationSha256);
  if (typeof input.engineId !== 'string' || !input.engineId.length || input.engineId.length > 256 || /[\x00-\x20\x7f]/.test(input.engineId) ||
    typeof input.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.image)) throw new PreviewPlanError();
  executionKeys(input.fingerprints, fingerprints);
  if (!Object.values(input.fingerprints).every(digest)) throw new PreviewPlanError();
  const preview = input.preparation.id.replaceAll('-', ''), origin = new URL(input.origin);
  executionTarget({ project: 'probe', installation: '0'.repeat(64), configSha256: '0'.repeat(64), runtime: input.preparation.runtime, origin: input.origin, networks: input.subnets });
  assertOrigin(input, preview, origin);
  return { preparation: structuredClone(input.preparation), preparationSha256: input.preparationSha256, engineId: input.engineId, image: input.image, origin: input.origin,
    subnets: Object.fromEntries(networkRoles.map(role => [role, input.subnets[role]])), fingerprints: Object.fromEntries(fingerprints.map(key => [key, input.fingerprints[key]])) };
}

function volumes(project) {
  const names = [...dataRoles, ...authorityRoles.flatMap(role => [`${role}-trust`, `${role}-input`])];
  return Object.fromEntries(names.map(role => [role, { name: `${project}_${role}` }]));
}
const mount = (volume, target, readOnly = false) => ({ volume, target, readOnly });
function serviceRoles(request, project) {
  const id = request.preparation.id.replaceAll('-', ''), roles = {};
  const add = (role, networks, memoryMiB, mounts = [], extra = {}) => {
    roles[role] = { name: `${project}-${role}`, networks, memoryBytes: memoryMiB * mib, cpuLimit: role === 'minio' ? 2 : 1, pidsLimit: 128, mounts,
      environment: ['gateway', 'ingress'].includes(role) ? {} : { FOGD_PREVIEW_ID: id },
      secretEnvironment: ['gateway', 'ingress'].includes(role) ? {} : { FOGD_PREVIEW_STORAGE_PASSWORD: 'storagePassword' }, ...extra };
  };
  add('minio', ['control', 'fleet-1', 'fleet-2'], 768, [mount('minio', '/data')]);
  add('bucket-init', ['control'], 128);
  for (const role of dataRoles.filter(role => role.startsWith('slot-'))) add(role, [role.slice(0, -2).replace('slot', 'fleet')], 512, [mount(role, '/var/lib/celld')]);
  for (const role of authorityRoles) {
    const mounts = [mount(`${role}-trust`, '/run/fogd-preview-trust', true), mount(`${role}-input`, role === 'controller' ? '/run/fogd-preview-input' : '/run/fogd-preview-service', true)];
    if (role === 'controller') mounts.unshift(mount(role, '/var/lib/fogd'));
    add(role, role === 'ingress' ? ['control', 'frontend'] : ['control', 'fleet-1', 'fleet-2'], 512, mounts);
  }
  roles.controller.secretEnvironment.FOGD_PREVIEW_GATEWAY_TOKEN = 'gatewayToken';
  roles.gateway.aliases = { control: [new URL(request.origin).hostname] };
  roles.ingress.publish = { host: '127.0.0.1', port: Number(new URL(request.origin).port || 443), target: 8080 };
  add('input-installer', [], 512, authorityRoles.flatMap(role => [
    mount(`${role}-trust`, `/run/fogd-preview-stage/${role}-trust`), mount(`${role}-input`, `/run/fogd-preview-stage/${role}-input`),
  ]), { environment: {}, secretEnvironment: {} });
  return roles;
}

// This constructs a fixed configuration template. It authorizes neither an image
// nor allocation. Reserve fresh resources before realizing it with the signed
// absolute deadline; runtime execution admission is required before any start.
export function createPreviewPlan(input) {
  try {
    const request = checkedRequest(input), preview = request.preparation.id, project = `fogd-preview-${preview.replaceAll('-', '')}`;
    const installation = hash(jsonBytes({ engineId: request.engineId, project, preview, bucket: `fogd-preview-${preview.replaceAll('-', '')}` }));
    return { schema: 1, kind: 'fogd-preview-plan', request, project, installation, networks: previewNetworks(project, request.subnets), volumes: volumes(project), services: serviceRoles(request, project),
      hardening: { readOnlyRoot: true, tmpfs: '/tmp:rw,noexec,nosuid,nodev', capDrop: ['ALL'], noNewPrivileges: true, restart: 'no', deadline: 'original-execution-expiry' } };
  } catch { throw new PreviewPlanError(); }
}
export function validatePreviewPlan(input) {
  try {
    const expected = createPreviewPlan(input.request);
    if (!isDeepStrictEqual(input, expected)) throw new PreviewPlanError();
    return expected;
  } catch { throw new PreviewPlanError(); }
}
export function previewPlanSha256(input) { return hash(jsonBytes(validatePreviewPlan(input))); }
export function previewPlanTarget(input) {
  const plan = validatePreviewPlan(input);
  return { project: plan.project, installation: plan.installation, configSha256: previewPlanSha256(plan), runtime: structuredClone(plan.request.preparation.runtime), origin: plan.request.origin, networks: structuredClone(plan.request.subnets) };
}
export function previewPlanMemory(input) { return Object.values(validatePreviewPlan(input).services).reduce((sum, service) => sum + service.memoryBytes, 0); }
