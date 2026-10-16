import { mkdir, chmod, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateKeypair } from './transport.mjs';

const dir = process.env.FOGD_TLS_DIR || '/var/lib/fogd-tls';
let text = '';
for await (const chunk of process.stdin) {
  text += chunk;
  if (Buffer.byteLength(text) > 262144) throw new Error('TLS input too large');
}
let value;
try { value = JSON.parse(text); } catch { throw new Error('Invalid TLS input'); }
const { cert, key, fingerprint, expires } = validateKeypair(value);
await mkdir(dir, { recursive: true, mode: 0o700 });
await chmod(dir, 0o700);
const temporary = join(dir, `${randomUUID()}.tmp`);
const file = await open(temporary, 'wx', 0o600);
try { await file.writeFile(JSON.stringify({ cert, key })); await file.sync(); }
finally { await file.close(); }
await rename(temporary, join(dir, 'keypair.json'));
const directory = await open(dir, 'r');
try { await directory.sync(); } finally { await directory.close(); }
console.log(JSON.stringify({ fingerprint, expires }));
