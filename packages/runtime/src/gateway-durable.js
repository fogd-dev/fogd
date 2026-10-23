import { gatewayAuthority } from './gateway-authority.mjs';
import { forwardRequest } from './gateway-forward.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url); let pair;
    try {
      const record = await gatewayAuthority(env);
      if (url.pathname === '/.well-known/fogd/health') return Response.json({ ok: true });
      const route = record.routes.find(value => value.host === url.hostname);
      if (!route) return new Response('Unknown app', { status: 404 });
      if (route.state !== 'active') return new Response('App activation paused', { status: 503 });
      pair = [env[`${route.slot}-0`], env[`${route.slot}-1`]];
      if (!pair.every(value => typeof value?.fetch === 'function')) throw new Error('Fleet unavailable');
    } catch { return new Response('Routing unavailable', { status: 503 }); }
    return forwardRequest(request, pair);
  },
};
