import { appName } from '@fogd/runtime/artifact';

export async function deployCapabilities(origin, token, app) {
  appName(app);
  const get = path => fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const response = await get(`/v1/capabilities?app=${encodeURIComponent(app)}`);
  if (response.status === 401 && response.headers.get('www-authenticate')?.startsWith('Basic realm="fogd admin"')) {
    await response.body?.cancel();
    // Older controllers route unknown URLs through admin authentication. Verify
    // the deploy credential on their existing read-only status surface first.
    const probe = await get('/v1/deployments/00000000-0000-4000-8000-000000000000');
    const valid = [200, 404].includes(probe.status); await probe.body?.cancel();
    if (!valid) throw new Error('Deployment capability negotiation failed; check the deploy credential and server');
    return { cronApps: false };
  }
  if (!response.ok) {
    if (response.status === 400) {
      const data = await capabilityJson(response);
      if (typeof data.error === 'string' && data.error.length <= 512 && !/[\x00-\x1f\x7f]/.test(data.error)) throw new Error(`Deployment capabilities refused: ${data.error}`);
    }
    await response.body?.cancel(); throw new Error('Deployment capability negotiation failed; inspect the server before building');
  }
  const result = await capabilityJson(response);
  if (result?.schema !== 1 || result.app !== app || typeof result.cronApps !== 'boolean') throw new Error('Server returned invalid deployment capabilities');
  return { cronApps: result.cronApps };
}

async function capabilityJson(response) {
  try {
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4096) throw new Error();
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks));
  } catch { throw new Error('Server returned invalid deployment capabilities'); }
}
