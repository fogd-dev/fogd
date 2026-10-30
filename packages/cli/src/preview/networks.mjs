import { isDeepStrictEqual } from 'node:util';
import { executionNetworks, refuseExecution } from './execution-shape.mjs';

const option = 'com.docker.network.bridge.gateway_mode_ipv4';
export const previewDns = Object.freeze({ dns: Object.freeze(['127.0.0.1']), dns_opt: Object.freeze(['timeout:1', 'attempts:1']) });

export function previewNetworks(project, subnets) {
  if (typeof project !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) refuseExecution();
  executionNetworks(subnets);
  return Object.fromEntries(Object.entries(subnets).map(([role, subnet]) => [role, {
    name: `${project}_${role}`, labels: { 'fogd.preview.project': project, 'fogd.preview.network': role }, driver: 'bridge', internal: role !== 'frontend', enable_ipv6: false,
    driver_opts: { [option]: role === 'frontend' ? 'nat' : 'isolated' }, ipam: { config: [{ subnet }] },
  }]));
}

// Actual network identity is checked separately from its declaration. No bridge
// address on internal networks may provide a route to host-bound services.
export function assertPreviewNetwork(declared, actual) {
  try {
    assertNetworkMode(declared, actual);
    assertNetworkOptions(declared, actual);
    assertNetworkAddressing(declared, actual.IPAM.Config);
  } catch { refuseExecution(); }
}
function assertNetworkMode(declared, actual) {
  const expected = { Name: declared.name, Driver: 'bridge', Scope: 'local', Internal: declared.internal, EnableIPv6: false, Ingress: false, ConfigOnly: false };
  const observed = Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]]));
  if (!isDeepStrictEqual(expected, observed) || actual.EnableIPv4 === false) refuseExecution();
  if (Object.entries(declared.labels).some(([key, value]) => actual.Labels?.[key] !== value)) refuseExecution();
}
function assertNetworkOptions(declared, actual) {
  if (!isDeepStrictEqual(actual.Options, declared.driver_opts) || actual.IPAM?.Driver !== 'default' || actual.ConfigFrom?.Network || Object.keys(actual.IPAM.Options || {}).length) refuseExecution();
}
function assertNetworkAddressing(declared, ranges) {
  if (!Array.isArray(ranges) || ranges.length !== 1 || ranges[0].Subnet !== declared.ipam.config[0].subnet) refuseExecution();
  if (declared.internal && ranges[0].Gateway) refuseExecution();
  if (Object.keys(ranges[0]).some(key => !['Subnet', 'Gateway'].includes(key))) refuseExecution();
}
