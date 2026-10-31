const phase = (name, roles, waitForExit = false) => Object.freeze({ name, roles: Object.freeze(roles), waitForExit });

// Startup and memory admission share the same ordering. A one-shot phase must
// exit successfully before the next phase can start; the installer runs alone.
export const previewStartupPhases = Object.freeze([
  phase('storage', ['minio']), phase('initialization', ['bucket-init'], true),
  phase('natives', ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b']),
  phase('controller', ['controller']), phase('gateway', ['gateway']), phase('ingress', ['ingress']),
]);
export const previewCompletedHelpers = Object.freeze(['input-installer', ...previewStartupPhases.filter(value => value.waitForExit).flatMap(value => value.roles)]);

export function previewMemoryStages() {
  const stages = [['input-installer']], active = [];
  for (const { roles, waitForExit } of previewStartupPhases) {
    stages.push([...active, ...roles]);
    if (!waitForExit) active.push(...roles);
  }
  return stages;
}
