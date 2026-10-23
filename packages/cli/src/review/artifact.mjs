import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { receiveArtifact, MAX_UPLOAD } from '@fogd/runtime/manifest';
import { regularFiles } from '@fogd/runtime/artifact';
import { controllerGet, boundedJson, discardResponse } from '../client-http.mjs';
import { transferFingerprint } from '../distribution/bootstrap.mjs';

export async function downloadReviewArtifact(origin, authorization, app, expected, directory) {
  let response;
  try { response = await controllerGet(origin, `/v1/deployments/${expected.id}/artifact`, authorization, { timeoutMs: 60000 }); }
  catch { throw new Error('Cannot download review artifact; check controller availability and TLS trust'); }
  if (!response.ok) { await discardResponse(response); throw new Error(`Review artifact is unavailable (HTTP ${response.status}); check administrator access and retained artifacts`); }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await discardResponse(response); throw new Error('Controller did not return a JSON artifact');
  }
  const body = await boundedJson(response, { limit: 2 * MAX_UPLOAD, invalid: 'Controller returned an unreadable or oversized review artifact; response contents are withheld' });
  if (body?.app !== app || body?.digest !== expected.digest) throw new Error('Downloaded artifact differs from the selected app or digest');
  await mkdir(directory, { mode: 0o700 });
  let release;
  // Reading a declaration does not authorize its execution on this controller.
  try { release = await receiveArtifact(body, directory, { cronApps: true }); }
  catch (error) {
    if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE'].includes(error.code)) throw new Error(`Cannot store local artifact copy (${error.code}); check output storage and permissions, and retain the partial review`);
    throw new Error('Downloaded artifact failed validation; retain the partial review directory and inspect controller integrity');
  }
  const files = [];
  for (const path of await regularFiles(directory)) files.push({ path, ...await transferFingerprint(join(directory, path), MAX_UPLOAD) });
  return { release, files };
}
