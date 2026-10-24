import { routeAuthorityVolume, routeEnrollmentVolume } from './durable-config.mjs';

const scripts = { initialize: 'packages/platform/src/import-route-enrollment.mjs', restore: 'packages/platform/src/import-restored-routes.mjs', retire: 'packages/platform/src/import-retired-routes.mjs' };
const mounts = [['controller', '/var/lib/fogd'], [routeAuthorityVolume, '/var/lib/fogd-routes'], [routeEnrollmentVolume, '/var/lib/fogd-enrollment']];

// Fixed stopped helpers share only these three volumes. Callers authorize the
// image/profile and sealed plan before constructing a command; no JSON path or
// executable selection reaches this builder.
export function durableRouteHelperArgs(config, image, operation) {
  if (!Object.hasOwn(scripts, operation)) throw new Error('Unknown stopped route operation');
  if (mounts.some(([role]) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(config.volumes[role]?.name))) throw new Error('Invalid stopped route volume');
  return ['run', '--pull', 'never', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...mounts.flatMap(([role, target]) => ['--mount', `type=volume,src=${config.volumes[role].name},dst=${target},volume-nocopy`]),
    '--entrypoint', '/usr/local/bin/node', image, scripts[operation]];
}
