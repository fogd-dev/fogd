import { validateArtifactPins } from '@fogd/platform/artifact-pins';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function assertSnapshotStateShape(state) {
  if (!record(state) || !record(state.apps) || !record(state.deployments) ||
      (state.requirements !== undefined && !Array.isArray(state.requirements))) throw new Error('Cannot establish recovery support from controller metadata');
  if ([...Object.values(state.apps), ...Object.values(state.deployments)].some(value => !record(value))) throw new Error('Cannot establish recovery support from controller metadata');
}

export function assertSnapshotState(state, capabilities) {
  assertSnapshotStateShape(state);
  validateArtifactPins(state);
  if (state.requirements?.some(value => !capabilities.includes(value))) throw new Error('Controller metadata requires an unsupported recovery capability');
}
