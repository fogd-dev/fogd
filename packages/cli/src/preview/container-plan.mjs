import { hash, uuid } from '../build-cache/paths.mjs';
import { executionKeys } from './execution-shape.mjs';
import { authorizePreviewExecution, inspectPreviewExecution } from './execution.mjs';
import { previewDns } from './networks.mjs';
import { validatePreviewPlan, previewPlanTarget, previewPlanSha256, PreviewPlanError } from './plan.mjs';

function networkArguments(plan, role, service) {
  const first = service.networks[0];
  return first ? ['--network', plan.networks[first].name, ...[role, ...(service.aliases?.[first] || [])].flatMap(value => ['--network-alias', value])] : ['--network', 'none'];
}

function roleSpecification(plan, grant, role, { publicKey, expectedGrantSha256, secretValues, allocationId }) {
  const service = plan.services[role];
  if (!service) throw new PreviewPlanError();
  const references = Object.values(service.secretEnvironment); executionKeys(secretValues, references);
  for (const key of references) if (typeof secretValues[key] !== 'string' || !/^[a-f0-9]{64}$/.test(secretValues[key]) || hash(secretValues[key]) !== plan.request.fingerprints[key]) throw new PreviewPlanError();
  const environment = { ...service.environment, ...Object.fromEntries(Object.entries(service.secretEnvironment).map(([key, reference]) => [key, secretValues[reference]])) };
  const labels = { 'fogd.preview.project': plan.project, 'fogd.preview.id': grant.preview, 'fogd.preview.role': role, 'fogd.preview.config': previewPlanSha256(plan) };
  if (allocationId !== undefined) {
    if (!uuid(allocationId)) throw new PreviewPlanError();
    labels['fogd.preview.allocation'] = allocationId;
  }
  const installer = role === 'input-installer';
  const authority = { publicKey, expectedGrantSha256, preparationSha256: plan.request.preparationSha256, target: previewPlanTarget(plan), fingerprints: plan.request.fingerprints };
  const command = installer ? ['/app/packages/cli/src/preview/input-installer.mjs', grant.expiresAt, JSON.stringify(authority)] : ['/app/packages/cli/src/preview/backend.mjs', role, grant.expiresAt];
  const configuration = { image: plan.request.image, entrypoint: ['/usr/local/bin/node'], command, environment,
    read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges'], tmpfs: [plan.hardening.tmpfs],
    volumes: service.mounts.map(value => ({ source: value.volume, target: value.target, read_only: value.readOnly })) };
  return { configuration, labels };
}

function expectedAuthority(plan, options) {
  if (typeof options.publicKey !== 'string' || hash(options.publicKey) !== plan.request.fingerprints.authorityPublicKey) throw new PreviewPlanError();
  return { publicKey: options.publicKey, expectedGrantSha256: options.expectedGrantSha256, preparationSha256: plan.request.preparationSha256, target: previewPlanTarget(plan) };
}

// Pure realization only. It does not allocate, connect or start anything. The
// coordinator must reserve capacity and verify actual stopped resources. Runtime
// execution admission and checked input installation are required before start.
export function previewContainerCommands(input, envelope, { role, publicKey, expectedGrantSha256, secretValues, allocationId }) {
  try {
    const plan = validatePreviewPlan(input), service = plan.services[role];
    if (plan.schema !== 3 || plan.request.storage.storage.schema !== 2) throw new PreviewPlanError();
    const grant = authorizePreviewExecution(envelope, expectedAuthority(plan, { publicKey, expectedGrantSha256 }));
    const { configuration, labels } = roleSpecification(plan, grant, role, { publicKey, expectedGrantSha256, secretValues, allocationId });
    const { environment, command } = configuration, installer = role === 'input-installer';
    const create = ['create', '--name', service.name, '--pull', 'never', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--restart', 'no',
      '--log-driver', plan.hardening.logging.driver, ...Object.entries(plan.hardening.logging.options).flatMap(([key, value]) => ['--log-opt', `${key}=${value}`]),
      '--tmpfs', plan.hardening.tmpfs, '--memory', String(service.memoryBytes), '--cpus', String(service.cpuLimit), '--pids-limit', String(service.pidsLimit),
      ...(installer ? ['--interactive'] : []), ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]), ...networkArguments(plan, role, service),
      ...previewDns.dns.flatMap(value => ['--dns', value]), ...previewDns.dns_opt.flatMap(value => ['--dns-option', value]),
      ...Object.entries(environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      ...service.mounts.flatMap(value => ['--mount', `type=volume,source=${plan.volumes[value.volume].name},target=${value.target},volume-nocopy${value.readOnly ? ',readonly' : ''}`]),
      ...(service.publish ? ['--publish', `${service.publish.host}:${service.publish.port}:${service.publish.target}`] : []),
      '--entrypoint', '/usr/local/bin/node', plan.request.image, ...command];
    const connect = service.networks.slice(1).map(network => ({ network: plan.networks[network].name, aliases: [role, ...(service.aliases?.[network] || [])] }));
    return { create, connect, configuration, labels };
  } catch { throw new PreviewPlanError(); }
}

export function previewServiceCommands(plan, envelope, options, allocationId) {
  return Object.fromEntries(Object.entries(plan.services).map(([role, service]) => [role, previewContainerCommands(plan, envelope, {
    publicKey: options.publicKey, expectedGrantSha256: options.expectedGrantSha256, allocationId, role,
    secretValues: Object.fromEntries(Object.values(service.secretEnvironment).map(key => [key, options.secretValues?.[key]])),
  })]));
}

// Bound historical configuration only. Never returns Docker mutation commands.
export function previewServiceInspection(input, envelope, options, allocationId) {
  try {
    const plan = validatePreviewPlan(input), grant = inspectPreviewExecution(envelope, expectedAuthority(plan, options));
    return Object.fromEntries(Object.entries(plan.services).map(([role, service]) => [role, roleSpecification(plan, grant, role, {
      publicKey: options.publicKey, expectedGrantSha256: options.expectedGrantSha256, allocationId,
      secretValues: Object.fromEntries(Object.values(service.secretEnvironment).map(key => [key, options.secretValues?.[key]])),
    })]));
  } catch { throw new PreviewPlanError(); }
}
