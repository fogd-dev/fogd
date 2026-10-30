import { constants } from 'node:fs';
import { open, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { jsonBytes, uuid } from '../build-cache/paths.mjs';
import { checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { validatePreviewPlan, previewPlanSha256 } from './plan.mjs';

const limit = 256 * 1024, projectPattern = /^fogd-preview-[a-f0-9]{32}$/;
export class PreviewHostError extends Error {
  constructor(reason) { super('Preview host operation refused; retain host records and inspect the pending operation'); this.code = 'PREVIEW_HOST_REFUSED'; this.reason = reason; }
}
export const hostRefusal = reason => { throw new PreviewHostError(reason); };
const privateFile = info => info.isFile() && info.nlink === 1 && info.uid === process.geteuid() && (info.mode & 0o7777) === 0o600 && info.size <= limit;

export async function readHostRecord(bound, name) {
  await checkHostDirectory(bound);
  const file = await open(join(bound.canonical, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!privateFile(before)) hostRefusal('record');
    const bytes = await file.readFile(), after = await file.stat(), named = await lstat(join(bound.canonical, name));
    if (!privateFile(after) || named.dev !== before.dev || named.ino !== before.ino || bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) hostRefusal('record');
    const value = JSON.parse(bytes);
    if (!bytes.equals(Buffer.from(jsonBytes(value)))) hostRefusal('record');
    await checkHostDirectory(bound); return value;
  } finally { await file.close(); }
}

// Append only. Any failed or partial write stays present and blocks the registry.
export async function appendHostRecord(bound, name, value) {
  const bytes = Buffer.from(jsonBytes(value));
  if (bytes.length > limit) hostRefusal('record');
  await checkHostDirectory(bound);
  const file = await open(join(bound.canonical, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.chmod(0o600); await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  await syncHostDirectory(bound); await checkHostDirectory(bound);
}

export async function readHostHolds(bound, engineId) {
  await checkHostDirectory(bound);
  const names = (await readdir(bound.canonical)).sort();
  if (names.length > 512 || names.some(name => !/^fogd-preview-[a-f0-9]{32}\.json$/.test(name))) hostRefusal('holds');
  const records = [], ids = new Set();
  for (const name of names) {
    const record = await readHostRecord(bound, name), plan = validatePreviewPlan(record.plan);
    const expected = { schema: 1, kind: 'fogd-preview-host-hold', id: record.id, createdAt: record.createdAt, planSha256: previewPlanSha256(plan), plan };
    if (!uuid(record.id) || ids.has(record.id) || typeof record.createdAt !== 'string' || new Date(record.createdAt).toISOString() !== record.createdAt ||
      !isDeepStrictEqual(record, expected) || name !== plan.project + '.json' || plan.request.engineId !== engineId) hostRefusal('holds');
    ids.add(record.id); records.push(record);
  }
  if (!isDeepStrictEqual((await readdir(bound.canonical)).sort(), names)) hostRefusal('holds-changed');
  return records;
}

export function assertRegisteredPreviewResources(observed, records) {
  const projects = new Set(records.map(record => record.plan.project));
  for (const [values, labels] of [[observed.containers, value => value.Config?.Labels], [observed.networks, value => value.Labels], [observed.volumes, value => value.Labels]]) {
    for (const value of values) {
      const metadata = labels(value) || {}, named = (value.Name || '').replace(/^\//, '').match(/^(fogd-preview-[a-f0-9]{32})(?:$|[-_])/);
      const project = metadata['fogd.preview.project'];
      if ((named && !projects.has(named[1])) || (project && !projects.has(project)) ||
        (Object.keys(metadata).some(key => key.startsWith('fogd.preview.')) && !projectPattern.test(project || ''))) hostRefusal('unregistered-resources');
    }
  }
}
