import { request as httpRequest } from 'node:http';

export function refreshGateway(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method || 'GET', headers: { Host: `refresh.localhost:${port}`, ...options.headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(15000, () => request.destroy(Error('Gateway request timed out')));
    request.end(options.body);
  });
}
