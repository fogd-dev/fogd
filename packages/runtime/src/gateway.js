let next = 0;
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/.well-known/fogd/health') return Response.json({ ok: true });
    let pair = [env.NODE_A, env.NODE_B];
    if (env.CONTROLLER) {
      try {
        const route = await env.CONTROLLER.fetch(`http://controller/internal/route?host=${encodeURIComponent(url.hostname)}`, { headers: { Authorization: `Bearer ${env.GATEWAY_TOKEN}` }, signal: AbortSignal.timeout(3000) });
        if (!route.ok) throw new Error('Route lookup failed');
        const target = await route.json();
        if (target.state === 'unknown') return new Response('Unknown app', { status: 404 });
        if (target.state !== 'active') return new Response('App activation paused', { status: 503 });
        pair = [env[`${target.slot}-0`], env[`${target.slot}-1`]];
        if (!pair.every(Boolean)) throw new Error('Unknown slot');
      } catch { return new Response('Routing unavailable', { status: 503 }); }
    } else if (url.hostname !== env.APP_HOST) return new Response('Unknown app', { status: 404 });
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
    const backends = next++ % 2 ? pair.toReversed() : pair;
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
