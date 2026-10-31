import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { exportArtifactReview } from '../review/export.mjs';
import { privateJSON, jsonBytes, hash } from '../build-cache/paths.mjs';
import { runtimeFamily } from '../runtime/catalog.mjs';
import { previewRuntimeFamily } from './runtime-catalog.mjs';

function previewLifetime(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || Number(value) < 60 || Number(value) > 3600) throw new Error('Preview lifetime must be an integer from 60 to 3600 seconds');
  return Number(value);
}

function preparationRuntime(name, candidateEnrollment) {
  let family;
  try { family = runtimeFamily(name); }
  catch { return previewRuntimeFamily(name, { candidateEnrollment }); }
  if (family.schema !== 3) throw new Error('Preview preparation requires an archive-capable qualified runtime family');
  return family;
}
export async function preparePreview({ id, output, runtime, lifetimeSeconds, candidateEnrollment = false }) {
  const lifetime = previewLifetime(lifetimeSeconds), family = preparationRuntime(runtime, candidateEnrollment);
  const { origin, directory, report } = await exportArtifactReview(id, output);
  if (!['pending', 'failed'].includes(report.proposed.status)) throw new Error('Prepare a pending or failed submission; this artifact is no longer proposed');
  const declarations = report.comparison.declarations.after;
  if (declarations.resources.queues || declarations.resources.crons) throw new Error('Preview preparation currently supports HTTP applications only; queue and scheduled execution need a separate preview policy');
  const preparation = { schema: 1, kind: 'fogd-preview-preparation', id: randomUUID(), status: 'prepared', preparedAt: new Date().toISOString(),
    source: { controller: origin, app: report.app, submission: report.proposed.id, digest: report.proposed.digest, reviewSha256: hash(jsonBytes(report)) },
    runtime: { family: family.id, catalogEntrySha256: hash(jsonBytes(family)) },
    policy: { lifetimeSeconds: lifetime, storage: 'fresh-empty-only', secrets: 'preview-only', requiredSecrets: declarations.requiredSecrets,
      background: 'disabled', network: 'no-external-egress', access: 'owner-authenticated', expiry: 'deny-requests-and-stop-writers', dataPromotion: 'none' },
    executionAuthorized: false, capacityReserved: false,
    scope: 'Verified artifact preparation only. No preview is launched or authorized. Storage, access, network and expiry enforcement must pass before an execution command is available.' };
  await privateJSON(join(directory, 'preview.json'), preparation);
  return { directory, preparationSha256: hash(jsonBytes(preparation)), ...preparation };
}
