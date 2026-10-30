import { appName } from '@fogd/runtime/artifact';
import { secretNames } from '@fogd/runtime/deployment';
import { controllerOrigin, uuid, digest } from '../build-cache/paths.mjs';

const invalid = () => new Error('Archive recovery review is invalid; private response contents are withheld');
export function recoverySelection(value) {
  if (!value || !uuid(value.archive) || !digest(value.identity) || !digest(value.snapshot) || !uuid(value.deployment) || !digest(value.digest) ||
    !(value.secretRevision === null || uuid(value.secretRevision))) throw invalid();
  return Object.fromEntries(['archive','identity','snapshot','deployment','digest','secretRevision'].map(key => [key,value[key]]));
}
export function recoveryReview(value, app, kind, controller) {
  appName(app);
  if (!['original','rotation'].includes(kind) || value?.app !== app || value.state !== 'pending' || value.execution !== 'held' || !digest(value.review)) throw invalid();
  const selection = recoverySelection(value.selection);
  if (kind === 'rotation' && selection.secretRevision === null) throw invalid();
  return { schema: 1, controller: controllerOrigin(controller), kind, app, state: 'pending', execution: 'held', selection, review: value.review,
    notice: 'Approval leaves HTTP and background recovery held. Acknowledgment and resume remain separate.' };
}
export function savedRecoveryReview(value, app, kind) {
  if (value?.schema !== 1 || value.kind !== kind || typeof value.controller !== 'string') throw invalid();
  return recoveryReview(value, app, kind, value.controller);
}
export function recoveryApproval(value, selected) {
  if (value?.state !== 'approved' || value.execution !== 'held' ||
    !['archive','identity','deployment','digest'].every(key => value[key] === selected[key])) throw invalid();
  return { schema: 1, ...Object.fromEntries(['archive','identity','deployment','digest'].map(key => [key,value[key]])), state: 'approved', execution: 'held' };
}
export function stagedSecrets(value, app, names, previous) {
  if (value?.app !== app || !uuid(value.revision) || value.revision === previous || JSON.stringify(secretNames(value.names)) !== JSON.stringify(names)) throw invalid();
  return { schema: 1, app, revision: value.revision, names, state: 'staged', execution: 'held' };
}
