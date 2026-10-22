import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { parseEnv } from 'node:util';
import { join } from 'node:path';

export async function httpsClient(host) {
  const settings = parseEnv(await readFile(host.env.FOGD_ENV_FILE, 'utf8'));
  return transport(host, 'Basic ' + Buffer.from(`${host.config.services.controller.environment.FOGD_ADMIN_USER}:${settings.FOGD_ADMIN_PASSWORD}`).toString('base64'));
}

export async function scopedClient(host, token) {
  if (typeof token !== 'string' || !token || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error('Invalid scoped credential');
  return transport(host, `Bearer ${token}`);
}

async function transport(host, authorization) {
  const ca = await readFile(host.env.NODE_EXTRA_CA_CERTS || join(host.output, 'certificate.pem'));
  return (path, { app, method = 'GET', body, headers = {}, maxResponseBytes = 4 * 1024 ** 2, timeoutMs = 10000 } = {}) => new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 64 * 1024 ** 2) { reject(new Error('Invalid HTTPS observation limit')); return; }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) { reject(new Error('Invalid HTTPS observation timeout')); return; }
    host.access?.({ kind: 'http', app: app || null, method, path });
    const req = request({ hostname: app ? `${app}.localhost` : 'localhost', port: app ? host.gatewayPort : host.adminPort, path, method, ca,
      headers: app ? headers : { ...headers, Authorization: authorization },
      lookup: (_, options, callback) => callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4),
    }, response => {
      let text = '', bytes = 0;
      response.setEncoding('utf8');
      response.on('data', part => { text += part; bytes += Buffer.byteLength(part); if (bytes > maxResponseBytes) req.destroy(new Error('HTTPS observation exceeds limit')); });
      response.on('end', () => resolve({ status: response.statusCode, text, json: () => JSON.parse(text) }));
      response.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTPS observation timed out'))); req.on('error', reject); req.end(body);
  });
}

export async function waitFor(label, observe, timeout = 120000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const result = await observe(); if (result) return result; } catch (error) { if (['FOGD_QUIET_WINDOW', 'FOGD_SELECTION_EXPIRED'].includes(error.code)) throw error; last = error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Observation did not complete: ${label}`, { cause: last });
}

export async function crossMinute() {
  const before = Date.now(), target = (Math.floor(before / 60000) + 1) * 60000 + 1500;
  while (Date.now() < target) await new Promise(resolve => setTimeout(resolve, Math.min(10000, target - Date.now())));
  return { before, after: Date.now() };
}
