import { verifiedArtifactReview, reviewFile } from './artifact-review.mjs';
import { ReviewUnavailableError } from './review-artifact.mjs';
import { artifactReviewPage, artifactFilePage, artifactReviewFailure } from './admin-review-page.mjs';

export async function artifactReviewRequest(request, url, controller, csrf, send) {
  const page = /^\/admin\/review\/([a-f0-9-]{36})(\/file)?$/.exec(url.pathname);
  const api = /^\/v1\/deployments\/([a-f0-9-]{36})\/review$/.exec(url.pathname);
  if (request.method !== 'GET' || !page && !api) return false;
  try {
    const input = selection(url, Boolean(page?.[2]));
    const output = await controller.exclusive(async () => {
      const snapshot = await verifiedArtifactReview(controller, (page || api)[1], input.review);
      if (api) return snapshot.report;
      return page[2] ? artifactFilePage(snapshot, reviewFile(snapshot, input.path, input.offset)) : artifactReviewPage(controller, snapshot, csrf);
    });
    send(200, output, api ? 'application/json' : 'text/html; charset=utf-8');
  } catch (error) {
    const known = error instanceof ReviewUnavailableError;
    const status = known ? error.status : 503, message = known ? error.message : 'Review could not be completed. Inspect retained controller state before deciding.';
    send(status, api ? { error: message } : artifactReviewFailure(message), api ? 'application/json' : 'text/html; charset=utf-8');
  }
  return true;
}
function selection(url, file) {
  const allowed = file ? ['path', 'review', 'offset'] : [];
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) || allowed.some(key => url.searchParams.getAll(key).length > 1)) throw new ReviewUnavailableError(400, 'Invalid review selection.');
  if (!file) return {};
  const path = url.searchParams.get('path'), review = url.searchParams.get('review'), offset = Number(url.searchParams.get('offset') ?? 0);
  if (!path || path.length > 512 || !/^[a-f0-9]{64}$/.test(review || '') || !Number.isSafeInteger(offset) || offset < 0) throw new ReviewUnavailableError(400, 'Invalid file preview selection.');
  return { path, review, offset };
}
