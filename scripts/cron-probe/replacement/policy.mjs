const releases = { old: { gate: null, next: 'new' }, new: { gate: 'after-migration', next: 'final' }, final: { gate: 'before-publication', next: null } };
const locations = { slot: 'slot-1', dir: '/var/lib/fogd', sourceRoot: '/var/lib/fogd/qualification/artifacts', output: '/var/lib/fogd/qualification/session' };
export function replacementPlan(artifacts) { return { ...locations, artifacts: structuredClone(artifacts) }; }
export function replacementRelease(policy, name, current = null) {
  const plan = policy?.replacement;
  if (policy?.schema !== 2 || !plan || !Object.hasOwn(releases, name)) throw new Error('Unqualified replacement release');
  for (const [key, value] of Object.entries(locations)) if (plan[key] !== value) throw new Error('Replacement location differs from its immutable contract');
  if ((current === null && name !== 'old') || (current !== null && (!Object.hasOwn(releases, current) || releases[current].next !== name))) throw new Error('Replacement release order differs from its immutable contract');
  const digest = plan.artifacts?.[name];
  if (!Object.hasOwn(plan.artifacts || {}, name) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Unqualified replacement artifact');
  return { ...locations, release: name, source: `${locations.sourceRoot}/${name}`, gate: releases[name].gate, digest };
}
export function replacementCommand(policy, current, command) {
  if (!command || !/^[a-f0-9-]{36}$/.test(command.id) || !['pause', 'resume', 'finish', 'update'].includes(command.operation)) throw new Error('Invalid replacement command');
  const allowed = command.operation === 'update' ? ['id', 'operation', 'release'] : ['id', 'operation'];
  if (Object.keys(command).some(key => !allowed.includes(key))) throw new Error('Replacement command cannot supply paths or gates');
  return command.operation === 'update' ? replacementRelease(policy, command.release, current) : null;
}
