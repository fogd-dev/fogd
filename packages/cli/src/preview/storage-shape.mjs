import { executionKeys } from './execution-shape.mjs';

export const previewStorageBytes = 1024 ** 3;
export const previewStorageChargeBytes = previewStorageBytes + 16 * 1024 ** 2;
export const previewStorageRoles = ['minio', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b', 'controller',
  'controller-trust', 'controller-input', 'gateway-trust', 'gateway-input', 'ingress-trust', 'ingress-input'];
const counter = value => Number.isSafeInteger(value) && value > 0;
const fail = () => { throw new Error('Invalid preview storage binding'); };
export function storageUuid(project) {
  const id = project.slice(13);
  return [id.slice(0, 8), id.slice(8, 12), id.slice(12, 16), id.slice(16, 20), id.slice(20)].join('-');
}
export function checkedIdentity(value) {
  executionKeys(value, ['device', 'inode']);
  if (!counter(value.device) || !counter(value.inode)) fail();
}
export function checkedDisk(value) {
  executionKeys(value, ['device', 'inode', 'bytes', 'allocatedBytes']);
  if (!counter(value.device) || !counter(value.inode) || value.bytes !== previewStorageBytes ||
    !counter(value.allocatedBytes) || value.allocatedBytes < previewStorageBytes) fail();
}
export function checkedAdmission(value, disk) {
  executionKeys(value, ['profileId', 'reservation', 'chargeBytes']);
  if (![value.profileId, value.reservation].every(v => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v)) ||
    value.chargeBytes !== previewStorageChargeBytes || disk.allocatedBytes > previewStorageChargeBytes) fail();
}
export function checkedLoop(value, disk, directory, readOnly = false) {
  executionKeys(value, ['name', 'back-file', 'back-ino', 'back-maj:min', 'maj:min', 'ro', 'autoclear', 'offset', 'sizelimit']);
  if (!/^\/dev\/loop[0-9]+$/.test(value.name) || value['back-file'] !== directory + '/disk.img' || value['back-ino'] !== disk.inode ||
    !/^[0-9]+:[0-9]+$/.test(value['back-maj:min']) || !/^7:[0-9]+$/.test(value['maj:min']) ||
    typeof value.ro !== 'boolean' || readOnly !== null && value.ro !== readOnly || value.autoclear !== false || value.offset !== 0 || value.sizelimit !== 0) fail();
}
export function checkedRoles(roles) {
  executionKeys(roles, previewStorageRoles);
  for (const role of previewStorageRoles) checkedIdentity(roles[role]);
  if (new Set(Object.values(roles).map(row => row.device)).size !== 1 ||
    new Set(Object.values(roles).map(row => row.inode)).size !== previewStorageRoles.length) fail();
}
