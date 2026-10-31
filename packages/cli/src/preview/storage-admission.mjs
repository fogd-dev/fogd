import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import { uuid } from '../build-cache/paths.mjs';
import { executionKeys } from './execution-shape.mjs';
import { previewStorageAdmissionOperation, previewStorageBytes, previewStorageChargeBytes } from './storage.mjs';

const counter = value => Number.isSafeInteger(value) && value >= 0;
function fail() { const error = new Error('Preview storage admission refused; retain its registry and resources'); error.code = 'PREVIEW_STORAGE_REFUSED'; error.reason = 'uncertain'; throw error; }
function request(input, action) {
  const { root, engineId } = input;
  if (typeof root !== 'string' || !/^\/[A-Za-z0-9_./-]{1,200}$/.test(root) || root.endsWith('/') || posix.normalize(root) !== root ||
    typeof engineId !== 'string' || !/^[^\x00-\x20\x7f]{1,256}$/.test(engineId)) fail();
  return { action, root, engineId };
}
const positiveIdentity = value => [value.device, value.inode].every(v => counter(v) && v > 0);
function checkPolicy(value, target) {
  executionKeys(value, ['schema', 'kind', 'id', 'root', 'rootIdentity', 'engineId', 'maxProjects', 'chargeBytes', 'headroomBytes', 'headroomInodes']);
  executionKeys(value.rootIdentity, ['device', 'inode']);
  if (target.maxProjects !== undefined && value.maxProjects !== target.maxProjects) fail();
  if (value.schema !== 1 || value.kind !== 'fogd-preview-storage-admission' || !uuid(value.id) || value.root !== target.root || value.engineId !== target.engineId ||
    !positiveIdentity(value.rootIdentity) ||
    !Number.isInteger(value.maxProjects) || value.maxProjects < 1 || value.maxProjects > 16 || value.chargeBytes !== previewStorageChargeBytes ||
    value.headroomBytes !== previewStorageBytes || value.headroomInodes !== 8192) fail();
}
function checkRows(rows, policy) {
  if (!Array.isArray(rows) || rows.length > policy.maxProjects) fail();
  for (const row of rows) {
    executionKeys(row, ['schema', 'kind', 'profileId', 'reservation', 'project', 'engineId', 'backingBytes', 'chargeBytes']);
    if (row.schema !== 1 || row.kind !== 'fogd-preview-storage-hold' || row.profileId !== policy.id || !uuid(row.reservation) ||
      !/^fogd-preview-[a-f0-9]{32}$/.test(row.project) || row.engineId !== policy.engineId || row.backingBytes !== previewStorageBytes || row.chargeBytes !== previewStorageChargeBytes) fail();
  }
  if (new Set(rows.map(row => row.project)).size !== rows.length || new Set(rows.map(row => row.reservation)).size !== rows.length) fail();
}
function status(value, target) {
  executionKeys(value, ['schema', 'kind', 'policy', 'heldProjects', 'heldChargeBytes', 'remainingProjects', 'pending', 'space', 'admissionOpen', 'reservations', 'resourcesRetained', 'executionAuthorized']);
  checkPolicy(value.policy, target); checkRows(value.reservations, value.policy);
  executionKeys(value.space, ['availableBytes', 'availableInodes', 'device']);
  if (!counter(value.space.availableBytes) || !counter(value.space.availableInodes) || value.space.device !== value.policy.rootIdentity.device) fail();
  checkBalance(value);
  if (value.schema !== 1 || value.kind !== 'fogd-preview-storage-admission-status' || value.resourcesRetained !== true || value.executionAuthorized !== false) fail();
  return structuredClone(value);
}
function checkBalance(value) {
  const held = value.reservations.length, remaining = value.policy.maxProjects - held;
  const open = !value.pending && remaining > 0 && value.space.availableBytes >= previewStorageChargeBytes + previewStorageBytes && value.space.availableInodes >= 8224;
  if (typeof value.pending !== 'boolean' || !isDeepStrictEqual(
    [value.heldProjects, value.heldChargeBytes, value.remainingProjects, value.admissionOpen],
    [held, held * previewStorageChargeBytes, remaining, open])) fail();
}
async function operation(input, target) {
  try { return status(await previewStorageAdmissionOperation(input, target), target); }
  catch (error) { if (error.code === 'PREVIEW_STORAGE_REFUSED') throw error; fail(); }
}
export function initializePreviewStorageAdmission(input, { maxProjects = 4 } = {}) {
  const target = request(input, 'initialize');
  if (!Number.isInteger(maxProjects) || maxProjects < 1 || maxProjects > 16) fail();
  return operation(input, { ...target, maxProjects });
}
export function inspectPreviewStorageAdmission(input) { return operation(input, request(input, 'admission')); }
