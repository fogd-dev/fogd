import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import { uuid, digest, hash, jsonBytes } from '../build-cache/paths.mjs';
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
// Shared policy validation for private owner profiles; it grants no capacity.
export function validatePreviewStoragePolicy(value, target) {
  try { checkPolicy(value, target); return structuredClone(value); }
  catch { fail(); }
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
  executionKeys(value, ['schema', 'kind', 'policy', 'quarantines', 'quarantinedProjects', 'quarantinedChargeBytes', 'heldProjects', 'heldChargeBytes', 'remainingProjects', 'pending', 'space', 'admissionOpen', 'reservations', 'resourcesRetained', 'executionAuthorized']);
  checkPolicy(value.policy, target); checkRows(value.reservations, value.policy);
  checkQuarantines(value.quarantines, value.reservations);
  executionKeys(value.space, ['availableBytes', 'availableInodes', 'device']);
  if (!counter(value.space.availableBytes) || !counter(value.space.availableInodes) || value.space.device !== value.policy.rootIdentity.device) fail();
  checkBalance(value);
  if (value.schema !== 2 || value.kind !== 'fogd-preview-storage-admission-status' || value.resourcesRetained !== true || value.executionAuthorized !== false) fail();
  return structuredClone(value);
}
function checkBalance(value) {
  const held = value.reservations.length, remaining = value.policy.maxProjects - held;
  const count = value.quarantines.length;
  const open = !value.pending && remaining > 0 && value.space.availableBytes >= previewStorageChargeBytes * (1 + count) + previewStorageBytes && value.space.availableInodes >= 8192 + 32 * (1 + count);
  if (typeof value.pending !== 'boolean' || !isDeepStrictEqual(
    [value.heldProjects, value.heldChargeBytes, value.remainingProjects, value.admissionOpen, value.quarantinedProjects, value.quarantinedChargeBytes],
    [held, held * previewStorageChargeBytes, remaining, open, count, count * previewStorageChargeBytes])) fail();
}
function checkQuarantines(rows, holds) {
  if (!Array.isArray(rows) || rows.length > holds.length) fail();
  for (const row of rows) {
    executionKeys(row, ['operation', 'project', 'profileId', 'reservation', 'chargeBytes']);
    const held = holds.find(hold => hold.project === row.project);
    if (!uuid(row.operation) || !held || row.profileId !== held.profileId || row.reservation !== held.reservation || row.chargeBytes !== held.chargeBytes) fail();
  }
  if (new Set(rows.map(row => row.project)).size !== rows.length || new Set(rows.map(row => row.operation)).size !== rows.length) fail();
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

function initializationIdentity(value) {
  executionKeys(value, ['device', 'inode']);
  if (!positiveIdentity(value)) fail();
}
function initializationEntry(name, value) {
  initializationIdentity(value.identity);
  if (name === 'holds') {
    executionKeys(value, ['kind', 'identity', 'empty']);
    if (value.kind !== 'directory' || value.empty !== true) fail();
  } else {
    executionKeys(value, ['kind', 'identity', 'sha256', 'bytes']);
    if (!['policy.json', 'operation.pending.json', 'initialization.recovered.json'].includes(name) ||
      value.kind !== 'file' || !digest(value.sha256) || !counter(value.bytes) || value.bytes > 65536) fail();
  }
}
function initializationState(value, target) {
  executionKeys(value, ['schema', 'kind', 'engineId', 'root', 'rootIdentity', 'registryIdentity', 'entries', 'rootEmpty', 'resourcesRetained', 'executionAuthorized']);
  if (value.schema !== 1 || value.kind !== 'fogd-preview-storage-initialization-state' || value.engineId !== target.engineId || value.root !== target.root ||
    value.rootEmpty !== true || value.resourcesRetained !== true || value.executionAuthorized !== false ||
    !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) fail();
  initializationIdentity(value.rootIdentity); initializationIdentity(value.registryIdentity);
  for (const [name, entry] of Object.entries(value.entries)) initializationEntry(name, entry);
  return structuredClone(value);
}
export async function inspectPreviewStorageAdmissionInitialization(input) {
  try {
    const target = request(input, 'inspect-initialization');
    const initialization = initializationState(await previewStorageAdmissionOperation(input, target), target);
    return { initialization, sha256: hash(jsonBytes(initialization)), resourcesRetained: true, executionAuthorized: false, ordinaryEnrollment: false };
  } catch { fail(); }
}
export async function recoverPreviewStorageAdmissionInitialization(input, { maxProjects, registrySha256 } = {}) {
  if (!Number.isInteger(maxProjects) || maxProjects < 1 || maxProjects > 16 || !digest(registrySha256)) fail();
  const report = await operation(input, { ...request(input, 'recover-initialization'), maxProjects, registrySha256 });
  if (report.heldProjects !== 0 || report.quarantinedProjects !== 0 || report.pending) fail();
  return report;
}

async function quarantineOperation(input, target) {
  if (!uuid(target.operation) || !/^fogd-preview-[a-f0-9]{32}$/.test(target.project || '')) fail();
  const report = await operation(input, target);
  if (!report.quarantines.some(row => row.project === target.project && row.operation === target.operation)) fail();
  return report;
}
export async function quarantinePreviewStorage(input, { operation: operationId } = {}) {
  return quarantineOperation(input, { ...request(input, 'quarantine'), project: input.project, operation: operationId });
}
export async function repairPreviewStorageHold(input, { operation: operationId, holdSha256 } = {}) {
  if (holdSha256 !== null && !digest(holdSha256)) fail();
  return quarantineOperation(input, { ...request(input, 'repair-hold'), project: input.project, operation: operationId, holdSha256 });
}
