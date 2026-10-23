import { mutateAdmin, uncertainAdminMutation } from '../admin-mutation.mjs';

const operations = {
  pin: { label: 'Artifact pin update', subject: 'Artifact pin', timeout: 15000, noun: 'artifact pin update', feature: 'artifact pins', limit: 4096, refusal: 'inspect the current artifact plan', advice: 'inspect a fresh artifact plan before retrying' },
  prune: { label: 'Artifact prune operation', subject: 'Artifact prune', timeout: 900000, noun: 'artifact prune operation', feature: 'artifact pruning', limit: 4 * 1024 ** 2, refusal: 'inspect the current artifact plan', advice: 'inspect artifact prune status before deciding whether to resume' },
};
export const uncertainArtifactMutation = kind => uncertainAdminMutation(operations[kind]);
export function mutateArtifact(kind, path, input) {
  if (!Object.hasOwn(operations, kind)) throw new Error('Unknown artifact mutation kind');
  return mutateAdmin(operations[kind], path, input);
}
