import { isDeepStrictEqual } from 'node:util';

export const appArchiveRotationCapability = 'fogd-app-archive-rotation-v1';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const refused = () => new Error('Archive secret rotation metadata is invalid; keep recovery held');

export function validateArchiveRotation(rotation, original, complete = false) {
  if (!rotation || typeof rotation !== 'object' || Array.isArray(rotation) || Object.keys(rotation).sort().join() !== 'secretRevision,valuesSha256,version' ||
    !uuid(rotation.secretRevision) || rotation.secretRevision === original?.secretRevision || !original?.requiredSecrets?.length ||
    !hash(rotation.valuesSha256) || !(rotation.version === null && !complete || typeof rotation.version === 'string' && rotation.version.length > 0 && rotation.version.length <= 512)) throw refused();
}
function validatePendingRotations(state, records) {
  let count = 0;
  for (const app of Object.values(state.apps)) {
    const rotation = app.archiveRecovery?.rotation;
    if (!Object.hasOwn(app.archiveRecovery || {}, 'rotation')) continue;
    const record = records[app.archiveRecovery.archive], original = record?.deployments?.[record.app.active];
    validateArchiveRotation(rotation, original);
    if (!isDeepStrictEqual(state.deployments[record.app.active], original)) throw refused();
    count++;
  }
  return count;
}
export function validateArchiveRotations(state, records, profile) {
  let count = validatePendingRotations(state, records);
  const decisions = new Map((state.decisions || []).map((decision, index) => [decision.id, index]));
  const latest = new Map();
  for (const record of Object.values(records)) {
    const rotation = record.restoration?.rotation;
    if (!Object.hasOwn(record.restoration || {}, 'rotation')) continue;
    validateArchiveRotation(rotation, record.deployments[record.app.active], true);
    const index = decisions.get(record.restoration.decision), previous = latest.get(record.app.active);
    if (record.status !== 'recovered' || index === undefined) throw refused();
    if (!previous || index > previous.index) latest.set(record.app.active, { index, rotation });
    count++;
  }
  for (const [id, { rotation }] of latest) {
    const release = state.deployments[id];
    if (release?.version !== rotation.version || release.secretRevision !== rotation.secretRevision) throw refused();
  }
  if (Boolean(count) !== state.requirements.includes(appArchiveRotationCapability) || count && profile.schema !== 4) throw refused();
}
export function assertArchiveRotationsSettled(state) {
  if (Object.values(state.apps).some(app => app.archiveRecovery?.rotation)) throw new Error('Resolve archive secret rotation before taking or restoring a snapshot');
}
