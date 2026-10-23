import { volumeNames, runtimePolicyVolume } from '../recovery/layout.mjs';
import { isDurableConfig, durableLegacyBase, routeAuthorityVolume, gatewayPolicyVolume, routeEnrollmentVolume } from './durable-config.mjs';

// Inventory for refusal/exclusion only. Validate the known minimum layout, then
// include every declared volume so later additions cannot hide a running writer.
// These names cannot authorize startup or repair an incomplete configuration.
export function installationVolumeNames(config) {
  try {
    const durable = isDurableConfig(config), required = volumeNames(durable ? durableLegacyBase(config) : config);
    if (durable) required.push(runtimePolicyVolume, routeAuthorityVolume, gatewayPolicyVolume, routeEnrollmentVolume);
    if (required.some(role => !Object.hasOwn(config.volumes, role))) throw new Error();
    const names = Object.values(config.volumes).map(volume => volume?.name);
    if (new Set(names).size !== names.length || names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(name))) throw new Error();
    return names;
  } catch { throw new Error('Cannot verify related installation volumes; keep its resources stopped'); }
}
