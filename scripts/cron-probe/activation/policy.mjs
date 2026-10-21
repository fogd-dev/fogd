const cases = {
  'first-publication': { mode: 'initial', fault: 'publish', artifact: 'first-publication' },
  'first-publication-recovery': { mode: 'recover', fault: 'none', artifact: 'first-publication' },
  'first-resume': { mode: 'retry', fault: 'resume', artifact: 'first-publication' },
  'first-resume-recovery': { mode: 'recover', fault: 'none', artifact: 'first-publication' },
  'update-durable-release': { mode: 'update', fault: 'released', artifact: 'update-durable-release' },
  'update-release-recovery': { mode: 'recover', fault: 'none', artifact: 'update-durable-release' },
  'paused-update-publication': { mode: 'paused-update', fault: 'publish', artifact: 'paused-update-publication' },
  'paused-update-recovery': { mode: 'recover', fault: 'none', artifact: 'paused-update-publication' },
};
export function interruptionPlan(artifacts) {
  return { slot: 'slot-1', dir: '/var/lib/fogd', sourceRoot: '/var/lib/fogd/qualification/artifacts',
    outputRoot: '/var/lib/fogd/qualification/cases', cases: structuredClone(cases), artifacts: structuredClone(artifacts) };
}
export function interruptionCase(policy, name) {
  const plan = policy?.interruption;
  if (policy?.schema !== 2 || !plan || !Object.hasOwn(cases, name)) throw new Error('Unqualified interruption case');
  const expected = cases[name], selected = plan.cases?.[name];
  if (!Object.hasOwn(plan.cases || {}, name) || !selected || Object.keys(selected).length !== 3 || Object.entries(expected).some(([key, value]) => selected[key] !== value)) throw new Error('Interruption case differs from its immutable contract');
  const locations = interruptionPlan({});
  for (const key of ['slot', 'dir', 'sourceRoot', 'outputRoot']) if (plan[key] !== locations[key]) throw new Error('Interruption location differs from its immutable contract');
  const digest = plan.artifacts?.[expected.artifact];
  if (!Object.hasOwn(plan.artifacts || {}, expected.artifact) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Unqualified interruption artifact');
  return { ...expected, slot: plan.slot, dir: plan.dir, output: `${plan.outputRoot}/${name}`, source: `${plan.sourceRoot}/${expected.artifact}`, digest };
}
