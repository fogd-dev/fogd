import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { sealRuntimeConfig } from './cron-preboot.mjs';

export const routeAuthorityVolume = 'route-authority';
export const gatewayPolicyVolume = 'gateway-policy';
export const routeEnrollmentVolume = 'route-enrollment';
const roles = [routeAuthorityVolume, gatewayPolicyVolume, routeEnrollmentVolume];
const controllerArgs = { legacy: ['packages/platform/src/main.mjs'], durable: ['packages/platform/src/main-durable.mjs'] };
const gatewayArgs = { legacy: ['packages/runtime/src/serve.mjs'], durable: ['packages/runtime/src/serve-durable.mjs'] };
const gatewayEnvironment = ['FOGD_PROFILE', 'FOGD_TLS', 'FOGD_PUBLIC_BIND_ADDRESS'];
const gatewayNetworks = ['fleet-1', 'fleet-2'];
const mount = (source, target, readOnly) => ({ type: 'volume', source, target, ...(readOnly ? { read_only: true } : {}), volume: { nocopy: true } });

// Any durable role volume makes this a sealed durable config: it must re-seal
// to itself exactly. Without one it is a legacy template to convert.
export const isDurableConfig = config => roles.some(role => Object.hasOwn(config?.volumes || {}, role));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function durablePlanSha256(config, profile) {
  const sealed = durableRuntimeConfig(config, profile);
  if (!isDeepStrictEqual(config, sealed)) throw new Error('Enrollment requires an exactly sealed durable plan');
  return createHash('sha256').update(JSON.stringify(canonical({ config: sealed, profile: validateRuntimePolicy(profile) }))).digest('hex');
}

// The schema 3 profile is the authority; the legacy seal only checks the common
// backend/storage/native constraints of the reconstructed base.
export function durableRuntimeConfig(input, profile) {
  try {
    const policy = validateRuntimePolicy(profile, input.services.controller.environment);
    if (policy.schema !== 3 || policy.routing !== 'durable' || !isDeepStrictEqual(policy.controllerArgs, controllerArgs.durable)) throw new Error('Durable launch requires a durable runtime policy');
    const { routing, ...legacy } = policy;
    const sealed = sealRuntimeConfig(durableLegacyBase(input), { ...legacy, schema: 2, controllerArgs: [...controllerArgs.legacy] });
    const expected = durableFromSealed(sealed, policy);
    if (isDurableConfig(input) && !isDeepStrictEqual(input, expected)) throw new Error('Durable launch configuration drifted');
    return expected;
  } catch {
    const error = new Error('Durable runtime requires a matching independently checked durable profile and sealed configuration; ordinary admission remains closed');
    error.code = 'DURABLE_CONFIG_REFUSED'; throw error;
  }
}

// Undo only the exact durable additions; anything else stays so the legacy seal
// or the final comparison against the untouched input refuses it.
export function durableLegacyBase(input) {
  const config = structuredClone(input);
  if (!isDurableConfig(config)) return config;
  for (const role of roles) delete config.volumes[role];
  for (const service of Object.values(config.services || {})) {
    if (Array.isArray(service.volumes)) service.volumes = service.volumes.filter(item => !roles.includes(item?.source));
  }
  const { controller, workerd } = config.services;
  if (isDeepStrictEqual(controller?.command, controllerArgs.durable)) controller.command = [...controllerArgs.legacy];
  restoreLegacyGateway(workerd, controller);
  return config;
}

function restoreLegacyGateway(workerd, controller) {
  if (!workerd) return;
  if (isDeepStrictEqual(workerd.command, gatewayArgs.durable)) workerd.command = [...gatewayArgs.legacy];
  workerd.environment = { ...workerd.environment };
  workerd.environment.FOGD_SLOTS ??= controller?.environment?.FOGD_SLOTS;
  workerd.environment.FOGD_CONTROLLER ??= 'controller:8083';
  workerd.networks = { ...workerd.networks };
  if (!Object.hasOwn(workerd.networks, 'control')) workerd.networks.control = structuredClone(controller?.networks?.control ?? null);
}

function durableFromSealed(sealed, policy) {
  const config = structuredClone(sealed), { controller, workerd } = config.services;
  for (const role of roles) config.volumes[role] = { name: `${config.name}_${role}` };
  if (new Set(Object.values(config.volumes).map(volume => volume.name)).size !== Object.keys(config.volumes).length) throw new Error('Durable roles require separate installation volumes');
  controller.command = [...policy.controllerArgs];
  controller.volumes = [...controller.volumes, mount(routeAuthorityVolume, '/var/lib/fogd-routes', false)];
  workerd.command = [...gatewayArgs.durable];
  workerd.restart = 'no';
  workerd.environment = Object.fromEntries(Object.entries(workerd.environment).filter(([key]) => gatewayEnvironment.includes(key)));
  workerd.networks = Object.fromEntries(Object.entries(workerd.networks).filter(([name]) => gatewayNetworks.includes(name)));
  workerd.volumes = [...workerd.volumes || [], mount(routeAuthorityVolume, '/var/lib/fogd-routes', true), mount(gatewayPolicyVolume, '/var/lib/fogd-gateway', true)];
  for (const service of Object.values(config.services)) {
    for (const volume of service.volumes || []) volume.volume = { ...volume.volume, nocopy: true };
  }
  return config;
}
