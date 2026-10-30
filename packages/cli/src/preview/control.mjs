import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { Controller } from '../../../platform/src/controller.mjs';
import { previewInputDirectory } from './input-files.mjs';
import { refuseExecution } from './execution-shape.mjs';

export function previewControlSlots(preview) {
  const id = preview.replaceAll('-', '');
  return [1, 2].map(n => ({ id: `slot-${n}`, prefix: `previews/${id}/slot-${n}`, nodes: [`slot-${n}-a`, `slot-${n}-b`] }));
}

function live(grant) { if (Date.now() >= Date.parse(grant.expiresAt)) refuseExecution(); }

// Only a verified immutable input from readPreviewControl enters here. There is
// no upload or approval HTTP API, and interrupted controller state never retries.
export async function activatePreviewControl(input, { directory, backend }) {
  const { grant, artifact, secrets } = input;
  live(grant); await previewInputDirectory(directory);
  if ((await readdir(directory)).length) refuseExecution();
  const slots = previewControlSlots(grant.preview), hostname = new URL(grant.target.origin).hostname;
  if (!hostname.startsWith(grant.source.app + '.')) refuseExecution();
  for (const slot of slots) await backend.assertUnclaimed(slot);
  live(grant);
  const controller = new Controller({ dir: directory, slots, backend, baseDomain: hostname.slice(grant.source.app.length + 1), queueApps: false, cronApps: false });
  await controller.init(); live(grant);
  const revision = grant.policy.requiredSecrets.length ? (await controller.replaceSecrets(grant.source.app, secrets)).revision : null;
  live(grant);
  const request = await controller.submit(artifact, 'team-token'); live(grant);
  const activated = await controller.mutate(request.id, grant.source.digest, 'approve', revision); live(grant);
  if (activated.status !== 'active') refuseExecution();
  return { controller, targetSubmission: request.id };
}

const fingerprint = value => createHash('sha256').update(value).digest();
export function previewControlServer(input, activated) {
  const { grant, gatewayToken } = input, expected = fingerprint(`Bearer ${gatewayToken}`);
  return createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (Date.now() >= Date.parse(grant.expiresAt)) { response.writeHead(410); response.end(); return; }
    if (!timingSafeEqual(fingerprint(request.headers.authorization || ''), expected)) { response.writeHead(401); response.end(); return; }
    let url;
    try { url = new URL(request.url, 'http://controller'); }
    catch { response.writeHead(400); response.end(); return; }
    if (request.method !== 'GET' || !['/internal/route', '/internal/preview'].includes(url.pathname)) { response.writeHead(404); response.end(); return; }
    const value = url.pathname === '/internal/route' ? activated.controller.route(url.searchParams.get('host') || '') : {
      preview: grant.preview, app: grant.source.app, submission: grant.source.submission, digest: grant.source.digest, expiresAt: grant.expiresAt,
      targetSubmission: activated.targetSubmission, status: 'active', productionActivation: false };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value));
  });
}
