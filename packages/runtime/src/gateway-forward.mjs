let reversed = false;
export async function forwardRequest(request, pair) {
  const url = new URL(request.url);
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return new Response('Invalid path', { status: 400 }); }
  if (/^\/__(?:void|fogd)(?:\/|$)/.test(path) || path.startsWith('/.well-known/celld/')) {
    return new Response('Not found', { status: 404 });
  }
  const headers = new Headers(request.headers);
  for (const key of [...headers.keys()]) {
    if (key.startsWith('x-void-') || key.startsWith('x-fogd-') || key.startsWith('cf-') || key.startsWith('x-forwarded-') || key === 'forwarded') headers.delete(key);
  }
  headers.set('x-forwarded-proto', url.protocol.slice(0, -1));
  headers.set('x-forwarded-host', url.host);
  const backends = reversed ? pair.toReversed() : pair;
  reversed = !reversed;
  for (const backend of backends) {
    try {
      const health = await backend.fetch('http://backend/.well-known/celld/health', { signal: AbortSignal.timeout(1500) });
      await health.body?.cancel();
      if (!health.ok) continue;
    } catch { continue; }
    // Once sent, a failed mutation may have committed. Never replay it.
    try { return await backend.fetch(new Request(request, { headers })); }
    catch { return new Response('Backend unavailable; outcome may be unknown', { status: 502 }); }
  }
  return new Response('No healthy replicas', { status: 503 });
}
