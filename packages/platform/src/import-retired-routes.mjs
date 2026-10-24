import { restoreRetiredRouteStores } from './route-restoration.mjs';

// Dedicated stopped retirement restoration at the fixed durable mount paths. Input is
// only the exact restoration request; it never selects paths, publishers or flags.
const MAX_BYTES = 16 * 1024 * 1024;
try {
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error();
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
  console.log(JSON.stringify(await restoreRetiredRouteStores(input)));
} catch (error) {
  process.stderr.write(`Route restoration failed${typeof error?.code === 'string' && /^ROUTE_[A-Z_]+$/.test(error.code) ? ` (${error.code})` : ''}; keep ingress stopped and retain all stores\n`);
  process.exitCode = 1;
}
