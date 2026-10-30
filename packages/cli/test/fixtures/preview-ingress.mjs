import { createServer, request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPreviewIngress } from '../../src/preview/ingress.mjs';

export const origin = 'https://preview.test';
export const key = 'a'.repeat(64);
export const identity = { preview: '00000000-0000-4000-8000-000000000001', submission: '00000000-0000-4000-8000-000000000002', app: 'demo', digest: 'b'.repeat(64) };
export async function ingressFixture(t, { respond, lifetime = 30000, changeConfig, publicPort } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fogd-preview-ingress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=preview.test', '-addext', 'subjectAltName=DNS:preview.test,IP:127.0.0.1']);
  const tls = { key: await readFile(join(directory, 'key.pem'), 'utf8'), cert: await readFile(join(directory, 'cert.pem'), 'utf8') };
  const calls = [];
  const backend = createServer(tls, async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    calls.push({ method: request.method, path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
    if (respond) return respond(request, response, calls);
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(calls.at(-1)));
  });
  backend.on('tlsClientError', () => {});
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { backend.close(resolve); backend.closeAllConnections(); }));
  const config = { origin: publicPort ? `${origin}:${publicPort}` : origin, target: `https://127.0.0.1:${backend.address().port}`, upstreamCA: tls.cert, tls, accessKey: key, identity, expiresAt: new Date(Date.now() + lifetime).toISOString() };
  changeConfig?.(config);
  const ingress = createPreviewIngress(config);
  await new Promise(resolve => ingress.server.listen(publicPort || 0, '127.0.0.1', resolve)); t.after(() => ingress.close());
  const send = (path = '/', options = {}) => new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: '127.0.0.1', port: ingress.server.address().port, servername: 'preview.test', ca: tls.cert,
      rejectUnauthorized: true, agent: false, path, method: options.method || 'GET', headers: { host: new URL(config.origin).host, ...options.headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject); response.on('aborted', () => reject(new Error('Preview response interrupted')));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject); request.end(options.body);
  });
  const login = async () => {
    const result = await send('/.well-known/fogd-preview/login', { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `key=${key}` });
    if (result.status !== 303) throw new Error(`Preview fixture login failed: ${result.status}`);
    return result.headers['set-cookie'][0].split(';', 1)[0];
  };
  return { ingress, backend, config, calls, send, login };
}
