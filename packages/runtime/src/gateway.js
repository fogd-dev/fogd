let next = 0;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/.well-known/fogd/health') return Response.json({ ok: true });
    if (url.hostname !== env.APP_HOST) return new Response('Unknown app', { status: 404 });
    if (/^\/__(?:void|fogd)(?:\/|$)/.test(url.pathname) || url.pathname.startsWith('/.well-known/celld/')) {
      return new Response('Not found', { status: 404 });
    }
    const headers = new Headers(request.headers);
    for (const key of [...headers.keys()]) {
      if (key.startsWith('x-void-') || key.startsWith('x-fogd-') || key.startsWith('cf-')) headers.delete(key);
    }
    const backends = next++ % 2 ? [env.NODE_B, env.NODE_A] : [env.NODE_A, env.NODE_B];
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
  },
};
