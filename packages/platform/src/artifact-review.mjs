import { artifactComparison } from './artifact-comparison.mjs';
import { decisionReviewToken, selectedSecretRevision } from './decision-history.mjs';
import { verifiedReviewArtifact, ReviewUnavailableError } from './review-artifact.mjs';

// Caller holds the controller's existing exclusive lock through verification.
export async function verifiedArtifactReview(controller, id, expectedReview) {
  const request = controller.state.deployments[id];
  if (!request) throw new ReviewUnavailableError(404, 'The selected submission is unavailable.');
  const review = decisionReviewToken(controller, id);
  if (expectedReview !== undefined && expectedReview !== review) throw new ReviewUnavailableError(409, 'Review context changed; reload the selected submission.');
  const app = controller.state.apps[request.app], active = controller.state.deployments[app?.active];
  if (app?.active && (!active || active.app !== request.app)) throw new ReviewUnavailableError();
  const proposed = await verifiedReviewArtifact(controller, id);
  const baseline = active ? active.id === id ? proposed : await verifiedReviewArtifact(controller, active.id) : null;
  return { report: { schema: 1, app: request.app, review,
    proposed: { id, digest: request.digest, status: request.status, secretRevision: selectedSecretRevision(controller, request) },
    active: active ? { id: active.id, digest: active.digest, status: active.status } : null,
    comparison: artifactComparison(baseline, proposed),
    state: { route: ['active', 'paused', 'retired'].includes(app?.route) ? app.route : 'unverified',
      quarantined: Boolean(app?.quarantined), retired: Boolean(app?.retirement), uncertainMigration: Boolean(app?.uncertain),
      appliedMigrations: app ? Array.isArray(app.migrations) ? app.migrations.length : null : 0, runtimeReadiness: 'not-assessed', applicationOutcome: 'not-assessed' } }, proposed, baseline };
}

export function reviewFile(snapshot, path, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ReviewUnavailableError(400, 'Invalid file preview offset.');
  const before = preview(snapshot.baseline, path, offset), after = preview(snapshot.proposed, path, offset);
  if (!before && !after) throw new ReviewUnavailableError(404, 'The selected file is not part of this verified comparison.');
  return { path, offset, before, after, next: [before, after].some(value => value?.more) ? offset + 65536 : null };
}
function preview(artifact, path, offset) {
  const file = artifact?.body.files.find(file => file.path === path);
  if (!file) return null;
  const bytes = Buffer.from(file.data, 'base64'), identity = artifact.files.find(file => file.path === path);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { ...identity, binary: true, text: 'Binary file. Use the artifact manifest and displayed digest for byte verification.', more: false }; }
  if (text.includes('\0')) return { ...identity, binary: true, text: 'Binary file. Use the artifact manifest and displayed digest for byte verification.', more: false };
  let start = Math.min(offset, text.length), end = Math.min(offset + 65536, text.length);
  if (low(text.charCodeAt(start)) && high(text.charCodeAt(start - 1))) start--;
  if (high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end++;
  return { ...identity, binary: false, text: text.slice(start, end), more: end < text.length };
}

const high = unit => unit >= 0xd800 && unit <= 0xdbff;
const low = unit => unit >= 0xdc00 && unit <= 0xdfff;
