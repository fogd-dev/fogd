export const previewBrowserHeaders = {
  'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'",
};

export class PreviewRequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function previewReply(response, status, message, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { ...previewBrowserHeaders, 'content-type': 'text/plain; charset=utf-8', connection: 'close', ...headers });
  response.end(message);
}
export async function previewBody(request, limit, signal) {
  const abort = () => request.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    let length = 0; const chunks = [];
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      length += chunk.length;
      if (length > limit) { request.pause(); throw new PreviewRequestError(413, 'Preview request exceeds its size limit'); }
      chunks.push(chunk);
    }
    if (signal.aborted) throw new PreviewRequestError(410, 'Preview access ended');
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener('abort', abort); }
}

export function previewRequestPath(request, origin) {
  const hosts = request.rawHeaders.filter((_value, index) => index % 2 === 0).filter(value => value.toLowerCase() === 'host');
  if (hosts.length !== 1 || request.headers.host?.toLowerCase() !== origin.host) throw new PreviewRequestError(421, 'Wrong preview host');
  if (!request.url.startsWith('/') || request.url.startsWith('//') || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method)) throw new PreviewRequestError(400, 'Unsupported preview request');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== origin.origin) throw new PreviewRequestError(403, 'Use the preview origin for this request');
  let path;
  try {
    const selected = new URL(request.url, origin);
    if (selected.origin !== origin.origin) throw new Error();
    path = decodeURIComponent(selected.pathname);
  } catch { throw new PreviewRequestError(400, 'Invalid preview path'); }
  if (/[\x00-\x1f\\]/.test(path)) throw new PreviewRequestError(400, 'Invalid preview path');
  return path;
}
