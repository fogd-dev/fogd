import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { RuntimeIdentity } from './runtime-identity.mjs';
import { CronRuntime } from './cron-runtime.mjs';
import { storageOrigin } from './runtime-identity-proof.mjs';

export function backendCronRuntime(backend, profile) {
  const identity = backendRuntimeIdentity(backend, profile);
  return new CronRuntime({ run: (slot, args) => backend.run(slot, args),
    inspect: node => backend.deployment(node), verify: slot => identity.verify(slot), verifyBootstrap: slot => identity.bootstrap(slot) });
}

// Explicit experimental composition; the default Backend does not enable cron.
export function backendRuntimeIdentity(backend, profile) {
  const expected = structuredClone(profile);
  return new RuntimeIdentity({ profile: expected,
    async identify(host, challenge) {
      const signal = AbortSignal.timeout(5000);
      const response = await fetch(`http://${host}:8082/runtime/identity?challenge=${encodeURIComponent(challenge)}`, { redirect: 'error', signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Runtime identity endpoint refused'); }
      return jsonBody(Readable.fromWeb(response.body), 2048, signal);
    },
    async cliDigest() {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(backend.executable)) hash.update(chunk);
      return hash.digest('hex');
    },
    async members(slot) {
      if (backend.env.FOGD_BUCKET !== expected.bucket || storageOrigin(backend.env.S3_ENDPOINT) !== storageOrigin(expected.storage.endpoint) ||
        backend.env.AWS_REGION !== expected.storage.region) throw new Error('Controller storage identity mismatch');
      const Bucket = backend.env.FOGD_BUCKET, Prefix = slot.prefix ? `${slot.prefix}/nodes/` : 'nodes/';
      const signal = AbortSignal.timeout(5000);
      const listed = await backend.s3.send(new ListObjectsV2Command({ Bucket, Prefix, MaxKeys: 256 }), { abortSignal: signal });
      if (listed.IsTruncated) throw new Error('Runtime membership inventory truncated');
      return Promise.all((listed.Contents || []).map(async object => {
        if (typeof object.Key !== 'string' || !object.Key.startsWith(Prefix)) throw new Error('Invalid node inventory key');
        const result = await backend.s3.send(new GetObjectCommand({ Bucket, Key: object.Key }), { abortSignal: signal });
        const lease = await jsonBody(result.Body, 65536, signal);
        return { key: object.Key.slice(Prefix.length), node: lease.node, addr: lease.addr, processKey: lease.probe_public_key, expiresMs: lease.expires_ms };
      }));
    },
  });
}

async function jsonBody(body, limit, signal) {
  const abort = () => body.destroy(new Error('Runtime identity read timed out'));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    let size = 0; const chunks = [];
    for await (const chunk of body) {
      size += chunk.length;
      if (size > limit) throw new Error('Runtime identity response exceeds limit');
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { signal.removeEventListener('abort', abort); }
}
