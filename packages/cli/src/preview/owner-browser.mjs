import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { hash, jsonBytes, privateJSON } from '../build-cache/paths.mjs';
import { bindHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { readPreviewOwnerControl, previewOwnerDocker, verifyPreviewOwnerEngine } from './owner-control.mjs';
import { performPreviewOwnerAction } from './owner-actions.mjs';
import { previewBody, previewReply, previewRequestPath, PreviewRequestError } from './ingress-http.mjs';
import { previewOwnerPage, previewOwnerStyle, previewOwnerScript } from './owner-browser-page.mjs';

const headers = { 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" };
const reply = (response, status, value, type = 'application/json') => previewReply(response, status,
  type === 'application/json' ? JSON.stringify(value) : value, { ...headers, 'content-type': type + '; charset=utf-8' });
const assets = { '/': ['text/html', previewOwnerPage], '/owner.css': ['text/css', previewOwnerStyle], '/owner.js': ['text/javascript', previewOwnerScript] };
const within = (path, parent) => path === parent || path.startsWith(parent + sep);
function authorized(request, key) {
  const token = request.headers.authorization;
  return typeof token === 'string' && /^Bearer [a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token.slice(7), 'hex'), key);
}
function actionBody(path, body) {
  let value;
  try { value = JSON.parse(body); } catch { throw new PreviewRequestError(400, 'Invalid owner action'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PreviewRequestError(400, 'Invalid owner action');
  if (path === '/status' && Object.keys(value).length === 0) return { action: 'status' };
  if (path === '/stop' && Object.keys(value).join(',') === 'reason' && ['owner-stop', 'declined', 'revoked'].includes(value.reason)) return { action: 'stop', reason: value.reason };
  throw new PreviewRequestError(400, 'Invalid owner action');
}

// Local operator capability only. No cookies, viewer credentials, execution,
// production approval, retirement or file-selected targets enter this HTTP API.
export async function createPreviewOwnerBrowser({ directory, allocationId, run }) {
  const bound = await bindHostDirectory(directory), control = await readPreviewOwnerControl(bound.canonical, allocationId);
  run ??= previewOwnerDocker(control.dockerContext);
  await verifyPreviewOwnerEngine(control, run);
  const temporary = await realpath(tmpdir());
  if (within(temporary, control.root) || within(temporary, bound.canonical)) throw new Error('Owner access location refused');
  const expectedControlSha256 = hash(jsonBytes(control)), key = randomBytes(32), tasks = new Set();
  let origin, closing = false, busy = false, closePromise;
  const handle = async (request, response) => {
    const path = previewRequestPath(request, origin);
    if (closing) return reply(response, 503, { error: 'Owner controls are closing' });
    if (request.method === 'GET' && Object.hasOwn(assets, path)) return reply(response, 200, assets[path][1], assets[path][0]);
    if (request.method !== 'POST' || !['/status', '/stop'].includes(path)) return reply(response, 404, { error: 'Not found' });
    if (!authorized(request, key)) return reply(response, 403, { error: 'Owner access refused' });
    if (request.headers['content-type'] !== 'application/json') return reply(response, 400, { error: 'Use an owner action' });
    const cancellation = new AbortController();
    const action = actionBody(path, await previewBody(request, 2048, cancellation.signal));
    if (closing || busy) return reply(response, 409, { error: 'Owner operation pending; inspect status before another action' });
    busy = true;
    try {
      const result = await performPreviewOwnerAction(action.action, { directory: bound.canonical, allocationId, expectedControlSha256, reason: action.reason, run });
      reply(response, 200, result);
    } finally { busy = false; }
  };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 }, (request, response) => {
    const task = handle(request, response).catch(error => reply(response, error instanceof PreviewRequestError ? error.status : 503,
      { error: error instanceof PreviewRequestError ? error.message : 'Owner action unavailable; retain evidence and inspect with the CLI' }));
    tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task));
  });
  server.maxConnections = 16; server.keepAliveTimeout = 1000;
  for (const event of ['upgrade', 'connect']) server.on(event, (_request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  const completion = new Promise(resolve => server.once('close', resolve));
  const close = () => closePromise ??= (async () => {
    closing = true; const stopped = new Promise(resolve => server.close(resolve)); server.closeIdleConnections();
    await Promise.allSettled([...tasks]); server.closeAllConnections(); await stopped;
  })();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = new URL('http://127.0.0.1:' + server.address().port);
    const output = await bindHostDirectory(await mkdtemp(join(temporary, 'fogd-preview-owner-')));
    if (within(output.canonical, control.root) || within(output.canonical, bound.canonical)) throw new Error('Owner access location refused');
    const accessFile = join(output.canonical, 'access.json');
    await privateJSON(accessFile, { schema: 1, kind: 'fogd-preview-owner-browser-access', origin: origin.origin, allocationId,
      accessKey: key.toString('hex'), capability: 'inspect-stop-only', expiresWhen: 'server-exits' });
    await syncHostDirectory(output);
    return { origin: origin.origin, accessFile, allocationId, capability: 'inspect-stop-only', completion, close };
  } catch (error) { await close(); throw error; }
}
