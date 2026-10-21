import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { parseEnv } from 'node:util';
import { join } from 'node:path';

export async function httpsClient(host) {
  const ca = await readFile(join(host.output, 'certificate.pem')), settings = parseEnv(await readFile(host.env.FOGD_ENV_FILE, 'utf8'));
  const authorization = 'Basic ' + Buffer.from(`${host.config.services.controller.environment.FOGD_ADMIN_USER}:${settings.FOGD_ADMIN_PASSWORD}`).toString('base64');
  return (path, { app, method = 'GET', body } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: app ? `${app}.localhost` : 'localhost', port: app ? host.gatewayPort : host.adminPort, path, method, ca,
      headers: app ? {} : { Authorization: authorization },
      lookup: (_, options, callback) => callback(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4),
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', part => { text += part; if (text.length > 4 * 1024 * 1024) req.destroy(new Error('HTTPS observation exceeds limit')); });
      response.on('end', () => resolve({ status: response.statusCode, text, json: () => JSON.parse(text) }));
      response.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('HTTPS observation timed out'))); req.on('error', reject); req.end(body);
  });
}

export async function waitFor(label, observe, timeout = 120000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const result = await observe(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Observation did not complete: ${label}`, { cause: last });
}

export async function crossMinute() {
  const before = Date.now(), target = (Math.floor(before / 60000) + 1) * 60000 + 1500;
  while (Date.now() < target) await new Promise(resolve => setTimeout(resolve, Math.min(10000, target - Date.now())));
  return { before, after: Date.now() };
}
