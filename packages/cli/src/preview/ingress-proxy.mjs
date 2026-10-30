import { request as httpsRequest } from 'node:https';
import { withoutPreviewCookie, previewCookie } from './ingress-access.mjs';
import { previewBrowserHeaders, previewReply } from './ingress-http.mjs';

const hop = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function cleanHeaders(input) {
  const excluded = new Set([...hop, ...String(input.connection || '').split(',').map(value => value.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !excluded.has(key) && !['x-forwarded-', 'x-void-', 'x-fogd-', 'cf-'].some(prefix => key.startsWith(prefix)) && !['forwarded', 'x-real-ip'].includes(key)));
}
function appCookies(values) {
  return (values || []).filter(value => value.split('=', 1)[0].trim().toLowerCase() !== previewCookie.toLowerCase())
    .map(value => value.split(';').filter(part => !/^\s*domain\s*=/i.test(part)).join(';'));
}
function responseHeaders(input, origin) {
  const headers = cleanHeaders(input);
  for (const key of Object.keys(headers)) if (key.startsWith('access-control-') || ['service-worker-allowed', 'clear-site-data', 'refresh', 'link', 'report-to', 'nel', 'alt-svc'].includes(key)) delete headers[key];
  if (headers.location && new URL(headers.location, origin).origin !== origin) throw new Error('External preview redirect refused');
  const cookies = appCookies(headers['set-cookie']); delete headers['set-cookie'];
  return { ...headers, ...previewBrowserHeaders, ...(cookies.length ? { 'set-cookie': cookies } : {}) };
}

export function proxyPreview(request, response, body, config, signal) {
  return new Promise(resolve => {
    const headers = cleanHeaders(request.headers); headers.host = new URL(config.origin).host;
    const cookie = withoutPreviewCookie(headers.cookie); delete headers.cookie;
    if (cookie) headers.cookie = cookie;
    delete headers['content-length'];
    if (body.length || ['POST', 'PUT', 'PATCH'].includes(request.method)) headers['content-length'] = String(body.length);
    const upstream = httpsRequest(config.target, { method: request.method, path: request.url, headers, ca: config.upstreamCA,
      servername: new URL(config.origin).hostname, rejectUnauthorized: true, agent: false, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) }, incoming => {
      try { response.writeHead(incoming.statusCode, responseHeaders(incoming.headers, config.origin)); }
      catch { incoming.destroy(); previewReply(response, 502, 'Preview response unavailable; outcome may be unknown'); resolve(); return; }
      incoming.on('error', () => { response.destroy(); resolve(); });
      incoming.pipe(response);
    });
    upstream.on('upgrade', (_incoming, socket) => { socket.destroy(); previewReply(response, 502, 'Preview protocol upgrade refused'); resolve(); });
    upstream.on('error', () => { previewReply(response, signal.aborted ? 410 : 502, 'Preview response unavailable; outcome may be unknown'); resolve(); });
    response.once('close', () => { upstream.destroy(); resolve(); });
    upstream.end(body);
  });
}
