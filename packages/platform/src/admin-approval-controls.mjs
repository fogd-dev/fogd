import { html } from './admin-html.mjs';
import { routeHold } from './route-publication.mjs';
import { selectedSecretRevision } from './decision-history.mjs';

export function approvalButtons(controller, request, review) {
  if (!['pending', 'failed'].includes(request.status)) return '';
  const app = controller.state.apps[request.app];
  if (app?.dispatch?.hold) return scheduledButtons(controller, request, app, review);
  const context = replacementContext(controller, request, app);
  const { held, httpHold, replacing, conflict } = context;
  const actions = [...(conflict ? [] : ['approve']), ...(held?.id === request.id && !(httpHold && app?.claim?.deployment === request.id) ? [] : ['reject'])];
  return replacementExplanation(context) + actions.map(action => {
    const replacement = replacing && action === 'approve' ? ` data-replaces="${html(held.id)}" data-replaces-digest="${html(held.digest)}"` : '';
    return approvalButton(controller, request, action, review, replacement, replacing);
  }).join(' ');
}
function scheduledButtons(controller, request, app, review) {
  if (app.dispatch.hold !== request.id) return '<p>Another artifact holds scheduled dispatch. Wait for or retry that activation before approving this request.</p>' + approvalButton(controller, request, 'reject', review);
  return approvalButton(controller, request, 'approve', review);
}
function replacementContext(controller, request, app) {
  const httpHold = controller.routes.durable ? routeHold(controller.state.routeAuthority.holds, request.app)?.id : null;
  const held = controller.state.deployments[app?.delivery?.hold || httpHold];
  const replacing = held && held.id !== request.id && (held.status === 'failed' || Boolean(httpHold));
  const predecessor = request.routeReplaces || request.replaces;
  const conflict = replacing && predecessor && (predecessor.deployment !== held.id || predecessor.digest !== held.digest);
  return { held, httpHold, replacing, conflict, queued: Boolean(app?.delivery?.hold) };
}
function replacementExplanation({ held, httpHold, replacing, conflict, queued }) {
  if (conflict) return '<p>This request records a different predecessor. Resubmit the artifact to request another approval.</p>';
  if (!replacing) return '';
  return `<p>Replacement approval preserves the ${httpHold && !queued ? 'HTTP' : 'queue'} hold and applied migrations. Replaces ${html(held.id)} with digest <code>${html(held.digest)}</code>.</p>`;
}
function approvalButton(controller, request, action, review, replacement = '', replacing = false) {
  const revision = selectedSecretRevision(controller, request), missing = action === 'approve' && (request.requiredSecrets || []).length > 0 && !revision;
  const label = action === 'approve' ? replacing ? 'Approve replacement' : request.status === 'failed' ? 'Retry approval' : 'approve' : 'reject';
  return `${missing ? '<p>Configure required secret values and reload this review before approval.</p>' : ''}<button data-id="${request.id}" data-digest="${request.digest}" data-action="${action}" data-secret-revision="${html(revision || '')}" data-review="${html(review)}"${replacement}${missing ? ' disabled' : ''}>${label}</button>`;
}
