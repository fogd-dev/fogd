import { validatePreviewPlan, previewPlanMemory, previewPlanSha256 } from './plan.mjs';
import { assertAvailableSubnets } from '../runtime/network-availability.mjs';

const headroomBytes = 1024 ** 3;
export class PreviewAdmissionError extends Error {
  constructor(reason) { super('Preview admission refused; check fresh resources, network placement and memory budgets'); this.code = 'PREVIEW_ADMISSION_REFUSED'; this.reason = reason; }
}
const refuse = reason => { throw new PreviewAdmissionError(reason); };
function assertResourceShapes(input) {
  const labels = value => value === null || value && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(item => typeof item === 'string');
  if (input.containers.some(value => typeof value.Name !== 'string' || !value.Name.startsWith('/') || !value.Config || !value.HostConfig ||
    !labels(value.Config.Labels) || !Object.hasOwn(value.HostConfig, 'PortBindings'))) refuse('inventory');
  if ([...input.networks, ...input.volumes].some(value => typeof value.Name !== 'string' || !labels(value.Labels))) refuse('inventory');
}
function inventory(input) {
  if (!input || !['containers', 'networks', 'volumes'].every(key => Array.isArray(input[key])) || !input.host ||
    input.host.OSType !== 'linux' || !['arm64', 'aarch64'].includes(input.host.Architecture) || input.host.Driver !== 'overlay2' ||
    typeof input.host.ID !== 'string' || !Number.isSafeInteger(input.host.MemTotal) || input.host.MemTotal <= headroomBytes) refuse('inventory');
  for (const [kind, key] of [['containers', 'Id'], ['networks', 'Id'], ['volumes', 'Name']]) {
    if (input[kind].some(value => typeof value?.[key] !== 'string' || !value[key]) || new Set(input[kind].map(value => value[key])).size !== input[kind].length) refuse('inventory');
  }
  assertResourceShapes(input);
}
function assertFresh(plan, observed) {
  const names = new Set(Object.values(plan.services).map(service => '/' + service.name));
  const named = (kind, key, declarations) => observed[kind].some(value => Object.values(declarations).some(expected => value[key] === expected.name));
  const sameLabels = value => value?.['fogd.preview.project'] === plan.project || value?.['fogd.preview.id'] === plan.request.preparation.id;
  if (observed.containers.some(value => names.has(value.Name) || sameLabels(value.Config?.Labels)) ||
    named('volumes', 'Name', plan.volumes) || named('networks', 'Name', plan.networks) ||
    [...observed.networks, ...observed.volumes].some(value => sameLabels(value.Labels))) refuse('resources-exist');
  try { assertAvailableSubnets(Object.values(plan.request.subnets), observed.networks); }
  catch { refuse('networks-unavailable'); }
}
function activeMemory(containers) {
  let total = 0;
  for (const container of containers) {
    const state = container.State;
    if (!state || !['Running', 'Restarting', 'Paused'].every(key => typeof state[key] === 'boolean')) refuse('inventory');
    if (!state.Running && !state.Restarting && !state.Paused) continue;
    const memory = container.HostConfig?.Memory;
    if (!Number.isSafeInteger(memory) || memory <= 0) refuse('unbounded-active-memory');
    total += memory;
    if (!Number.isSafeInteger(total)) refuse('inventory');
  }
  return total;
}
const active = container => container.State.Running || container.State.Restarting || container.State.Paused;
function heldCredit(plan, containers) {
  const fingerprint = previewPlanSha256(plan);
  return Object.entries(plan.services).reduce((sum, [role, service]) => {
    const limits = containers.filter(container => active(container) && container.Name === '/' + service.name && container.Image === plan.request.image && container.Config?.Labels?.['fogd.preview.project'] === plan.project &&
      container.Config.Labels['fogd.preview.config'] === fingerprint && container.Config.Labels['fogd.preview.role'] === role).map(container => container.HostConfig.Memory);
    return sum + Math.min(service.memoryBytes, Math.max(0, ...limits));
  }, 0);
}
function reservedMemory(plan, held, containers) {
  if (!Array.isArray(held)) refuse('reservations-unknown');
  let total = 0, envelopeBytes = 0; const projects = new Set();
  for (const input of held) {
    const other = validatePreviewPlan(input);
    if (projects.has(other.project)) refuse('reservations-duplicate');
    projects.add(other.project);
    if (other.request.engineId !== plan.request.engineId) refuse('reservation-engine');
    if (other.project === plan.project || other.request.preparation.id === plan.request.preparation.id) refuse('resources-held');
    try { assertAvailableSubnets(Object.values(plan.request.subnets), Object.values(other.networks).map(network => ({ IPAM: { Config: [{ Subnet: network.ipam.config[0].subnet }] } }))); }
    catch { refuse('networks-held'); }
    if (other.services.ingress.publish.port === plan.services.ingress.publish.port) refuse('port-held');
    const budget = previewPlanMemory(other); envelopeBytes += budget;
    total += budget - heldCredit(other, containers);
  }
  return { additionalBytes: total, envelopeBytes };
}
function assertPort(plan, containers) {
  const port = String(plan.services.ingress.publish.port);
  for (const container of containers) {
    const bindings = container.HostConfig?.PortBindings;
    if (bindings === undefined || bindings === null) continue;
    if (typeof bindings !== 'object' || Array.isArray(bindings)) refuse('inventory');
    for (const values of Object.values(bindings)) {
      if (values === null) continue;
      if (!Array.isArray(values)) refuse('inventory');
      if (values.some(value => !value || typeof value.HostIp !== 'string' || typeof value.HostPort !== 'string')) refuse('inventory');
      if (values.some(value => value.HostPort === port)) refuse('port-used');
    }
  }
}

// Read-only eligibility only: this is not a capacity reservation, runtime
// admission or execution grant. Enrollment must recheck under its host lock and
// include all held allocations; unrelated processes may still occupy a port.
export function assessPreviewAdmission(input, observed, heldPlans) {
  const plan = validatePreviewPlan(input); inventory(observed);
  if (observed.host.ID !== plan.request.engineId) refuse('engine');
  assertFresh(plan, observed); assertPort(plan, observed.containers);
  return memoryEligibility(plan, observed, heldPlans);
}

// Memory eligibility alone grants no resource, port, runtime or launch admission.
// Startup checks its existing exact graph separately and excludes its own hold.
export function assessPreviewMemory(input, observed, heldPlans) {
  const plan = validatePreviewPlan(input); inventory(observed);
  if (observed.host.ID !== plan.request.engineId) refuse('engine');
  return memoryEligibility(plan, observed, heldPlans);
}

function memoryEligibility(plan, observed, heldPlans) {
  const activeLimitBytes = activeMemory(observed.containers), held = reservedMemory(plan, heldPlans, observed.containers), heldLimitBytes = held.additionalBytes, requestedLimitBytes = previewPlanMemory(plan);
  const neededBytes = headroomBytes + activeLimitBytes + heldLimitBytes + requestedLimitBytes;
  if (!Number.isSafeInteger(neededBytes) || neededBytes > observed.host.MemTotal) refuse('capacity');
  return { eligible: true, capacityReserved: false, executionAuthorized: false, engineId: observed.host.ID,
    memory: { hostBytes: observed.host.MemTotal, headroomBytes, activeLimitBytes, heldLimitBytes, heldEnvelopeBytes: held.envelopeBytes, requestedLimitBytes },
    cpuScope: 'Container quotas are upper bounds, not reservations or per-worker CPU limits' };
}
