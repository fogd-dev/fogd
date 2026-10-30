import { checkMutation } from './admin-secrets.mjs';

const actions = {
  'GET:': { read: 'review' },
  'GET:rotation': { read: 'reviewRotation' },
  'PUT:rotation/secrets': { mutate: 'stageRotation', limit: 65536 },
  'POST:approve': { mutate: 'approve', limit: 4096 },
  'POST:rotation/approve': { mutate: 'rotate', limit: 4096 },
};
async function mutation(archives, action, name, input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Archive recovery requires a JSON object');
  if (action.mutate === 'stageRotation') return archives.stageRotation(name, input);
  const { review, ...selection } = input;
  return archives[action.mutate](name, selection, { actor, review });
}
export async function archiveRecoveryRequest(request, url, controller, csrf, body, send, actor) {
  if (!controller.archives?.enabled) return false;
  const match = /^\/v1\/apps\/([a-z0-9-]+)\/archive-recovery(?:\/(approve|rotation|rotation\/secrets|rotation\/approve))?$/.exec(url.pathname);
  if (!match) return false;
  const action = actions[`${request.method}:${match[2] || ''}`];
  if (!action) return false;
  if (action.read) { send(200, await controller.archives[action.read](match[1])); return true; }
  try { checkMutation(request, csrf); }
  catch (error) { send(403, { error: error.message }); return true; }
  send(200, await mutation(controller.archives, action, match[1], await body(request, action.limit), actor));
  return true;
}
