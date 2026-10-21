// Reviewed private profiles select their programs here. A manifest or
// environment variable cannot introduce executable files into either image.
const shared = {
  'backend.mjs': './backend.mjs',
  'controller-artifact.mjs': '../../queue-probe/controller-artifact.mjs',
};
function releasePrograms(contract) {
  return { ...shared, 'controller.mjs': '../activation/idle.mjs',
    'release-controller.mjs': '../release/controller.mjs', 'release-policy.mjs': '../release/policy.mjs', 'release-contract.mjs': contract,
    'update-audit.mjs': '../release/update-audit.mjs', 'minute.mjs': '../minute.mjs' };
}
const profiles = {
  recovery: { ...shared, 'controller.mjs': './controller.mjs' },
  activation: { ...shared, 'controller.mjs': '../activation/idle.mjs',
    'interruption-controller.mjs': '../activation/controller.mjs', 'interruption-policy.mjs': '../activation/policy.mjs',
    'minute.mjs': '../minute.mjs' },
  replacement: releasePrograms('../replacement/contract.mjs'),
  failures: { ...releasePrograms('../faults/contract.mjs'), 'failure-observation.mjs': '../faults/observation.mjs', 'read-records.mjs': '../release/read-records.mjs' },
};
export function sealedPrograms(kind) {
  if (!Object.hasOwn(profiles, kind)) throw new Error('Unknown sealed qualification profile');
  return Object.fromEntries(Object.entries(profiles[kind]).map(([name, path]) => [name, new URL(path, import.meta.url)]));
}
