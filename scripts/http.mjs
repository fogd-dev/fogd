import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

// Node fetch does not permit a Host override; use HTTP for local virtual hosts.
export function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const send = url.startsWith('https:') ? httpsRequest : httpRequest;
    const req = send(url, { method: options.method, headers: options.headers, signal: options.signal }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}
