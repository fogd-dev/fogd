// Runs in the independently verified image. One bounded GET to an explicit app path:
// only the status line and time-to-headers leave; headers, body and raw errors never do.
// Path grammar is deliberately conservative ASCII: unreserved, sub-delims except ';', ':', '@', '/', and
// well-formed %XX. Every percent-decoded layer must also stay clear of controls, '\', '?', '#', ';', '//',
// dot segments and reserved internal routes (case-insensitive), so encoding cannot alias them.
import http from 'node:http';
import https from 'node:https';
import { isIPv4 } from 'node:net';

const PATH_ERROR = 'Check path must be an explicit public origin-form path';
const INPUT_ERROR = 'Check input is invalid';
const RAW_PATH = /^\/[A-Za-z0-9\-._~!$&'()*+,=:@/%]*$/;
const UNSAFE_LAYER = /[\u0000-\u001f\u007f-\u009f\\?#;]|\/\/|(?:^|\/)\.{1,2}(?:\/|$)/;
const RESERVED = /^\/(?:__void|__fogd|\.well-known\/celld|\.well-known\/fogd)(?:\/|$)/i;
const KEYS = ['address', 'host', 'tls', 'path', 'ca'];

function decodeLayer(value) {
  try { return decodeURIComponent(value); } catch { throw new Error(PATH_ERROR); }
}
export function validateCheckPath(path) {
  if (typeof path !== 'string' || path.length > 512 || !RAW_PATH.test(path) || /%(?![0-9A-Fa-f]{2})/.test(path)) throw new Error(PATH_ERROR);
  for (let layer = path, previous = null; layer !== previous; previous = layer, layer = decodeLayer(layer)) {
    if (UNSAFE_LAYER.test(layer) || RESERVED.test(layer)) throw new Error(PATH_ERROR);
  }
  return path;
}
const hostname = value => typeof value === 'string' && value.length <= 253 && value.includes('.') &&
  value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
const pem = value => value === null || (typeof value === 'string' && value.length <= 65536 && value.includes('-----BEGIN CERTIFICATE-----'));
function validateInput(input) {
  const exact = input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === KEYS.length && KEYS.every(key => Object.hasOwn(input, key));
  if (!exact || !isIPv4(input.address) || !hostname(input.host) || typeof input.tls !== 'boolean' || !pem(input.ca)) throw new Error(INPUT_ERROR);
  return { ...input, path: validateCheckPath(input.path) };
}
function requestOptions({ address, host, tls, path, ca }, port) {
  const options = { host: address, port, path, method: 'GET', agent: false, headers: { host } };
  return tls ? { ...options, servername: host, rejectUnauthorized: true, ...(ca === null ? {} : { ca }) } : options;
}

// Programmatic options exist for ephemeral test ports and short deadlines; main() never passes them.
export async function checkGateway(input, { port = 8080, timeoutMs = 5000 } = {}) {
  const checked = validateInput(input), start = performance.now();
  return new Promise(resolve => {
    let result = null;
    const settle = value => { result ??= value; };
    const request = (checked.tls ? https : http).request(requestOptions(checked, port));
    const deadline = setTimeout(() => { settle({ httpStatus: null, headersMs: null, reason: 'timeout' }); request.destroy(); }, timeoutMs);
    request.on('response', response => {
      settle({ httpStatus: response.statusCode, headersMs: Math.round(performance.now() - start), reason: null });
      response.on('error', () => {}); response.destroy(); request.destroy();
    });
    request.on('upgrade', (_response, socket) => {
      settle({ httpStatus: null, headersMs: null, reason: 'transport-unavailable' }); socket.destroy(); request.destroy();
    });
    request.on('error', () => settle({ httpStatus: null, headersMs: null, reason: 'transport-unavailable' }));
    request.on('close', () => {
      clearTimeout(deadline);
      resolve(result ?? { httpStatus: null, headersMs: null, reason: 'transport-unavailable' });
    });
    request.end();
  });
}

export async function main() {
  let text = '';
  for await (const part of process.stdin) { text += part; if (Buffer.byteLength(text) > 131072) throw new Error('Check input is oversized'); }
  console.log(JSON.stringify(await checkGateway(JSON.parse(text))));
}
