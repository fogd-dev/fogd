import { createServer } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { validateKeypair } from '@fogd/runtime/transport';
import { previewDeadline } from './deadline.mjs';
import { previewAccess, previewPath, accessPage } from './ingress-access.mjs';
import { previewBody, previewReply, previewRequestPath, PreviewRequestError } from './ingress-http.mjs';
import { proxyPreview } from './ingress-proxy.mjs';

function httpsOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new Error('Preview ingress requires exact HTTPS origins');
  return url;
}

function previewTLS(input, hostname) {
  const pair = validateKeypair(input), cert = new X509Certificate(pair.cert);
  const match = isIP(hostname) ? cert.checkIP(hostname) : cert.checkHost(hostname);
  if (!match) throw new Error('Preview certificate must cover its public origin');
  return pair;
}

export function createPreviewIngress(input) {
  const config = structuredClone(input);
  const origin = httpsOrigin(config.origin), target = httpsOrigin(config.target), expires = previewDeadline(config.expiresAt);
  if (typeof config.upstreamCA !== 'string' || !config.upstreamCA) throw new Error('Preview backend requires independent TLS trust');
  const identity = structuredClone(config.identity), access = previewAccess({ ...config, identity });
  const active = new Set(); let revoked = false;
  const ended = () => revoked || Date.now() >= expires;
  const revoke = () => { revoked = true; clearTimeout(timer); for (const request of active) request.abort(); };
  const handle = async (request, response) => {
    const path = previewRequestPath(request, origin);
    if (ended()) return previewReply(response, 410, 'Preview access ended', { 'set-cookie': access.clearCookie });
    if (active.size >= 16) return previewReply(response, 429, 'Preview request capacity reached');
    const cancellation = new AbortController(); active.add(cancellation);
    const disconnected = () => cancellation.abort(); response.once('close', disconnected);
    try {
      if (path === `${previewPath}/login`) return await login(request, response, cancellation.signal);
      if (!access.authenticated(request.headers.cookie)) return previewReply(response, 401, accessPage(identity, config.expiresAt), { 'content-type': 'text/html; charset=utf-8' });
      if (path.startsWith(previewPath)) return reserved(request, response, path);
      const body = await previewBody(request, 2 * 1024 * 1024, cancellation.signal);
      if (ended()) return previewReply(response, 410, 'Preview access ended');
      await proxyPreview(request, response, body, { target, origin: config.origin, upstreamCA: config.upstreamCA }, cancellation.signal);
    } finally { response.removeListener('close', disconnected); active.delete(cancellation); }
  };
  const login = async (request, response, signal) => {
    if (request.method !== 'POST' || request.headers['content-type'] !== 'application/x-www-form-urlencoded') return previewReply(response, 400, 'Use the preview access form');
    const form = new URLSearchParams((await previewBody(request, 2048, signal)).toString('utf8'));
    if (ended()) return previewReply(response, 410, 'Preview access ended');
    if ([...form.keys()].some(key => key !== 'key') || form.getAll('key').length !== 1 || !access.login(form.get('key'))) return previewReply(response, 403, 'Preview access refused');
    previewReply(response, 303, '', { location: '/', 'set-cookie': access.cookie() });
  };
  const reserved = (request, response, path) => {
    if (path === `${previewPath}/logout` && request.method === 'POST') return previewReply(response, 303, '', { location: '/', 'set-cookie': access.clearCookie });
    if (path === `${previewPath}/status` && request.method === 'GET') return previewReply(response, 200, JSON.stringify({ status: 'active', ...identity, expiresAt: config.expiresAt }), { 'content-type': 'application/json' });
    previewReply(response, 404, 'Not found');
  };
  const tls = previewTLS(config.tls, origin.hostname), server = createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2', maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000 }, (request, response) => {
    handle(request, response).catch(error => previewReply(response, error instanceof PreviewRequestError ? error.status : 503, error instanceof PreviewRequestError ? error.message : 'Preview unavailable'));
  });
  server.keepAliveTimeout = 1000;
  for (const event of ['upgrade', 'connect']) server.on(event, (_request, socket) => { socket.on('error', () => {}); socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.on('checkContinue', (_request, response) => previewReply(response, 417, 'Preview expectations are unsupported'));
  const timer = setTimeout(revoke, Math.max(0, expires - Date.now())); timer.unref();
  server.once('close', revoke);
  return { server, revoke, close: () => new Promise(resolve => { revoke(); server.close(() => resolve()); server.closeAllConnections(); }) };
}
