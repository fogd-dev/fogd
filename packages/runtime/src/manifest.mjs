import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appName, regularFiles, artifactDigest, translateConfig, resourceIdentity } from './artifact.mjs';

export const MAX_UPLOAD = 32 * 1024 * 1024;
export async function manifest(dir, release) {
  const files = [];
  for (const path of await regularFiles(dir)) {
    if (path !== 'fogd-release.json') files.push({ path, data: (await readFile(join(dir, path))).toString('base64') });
  }
  return { app: release.app, digest: release.digest, files };
}
export async function receiveArtifact(body, dir) {
  appName(body.app);
  if (!/^[a-f0-9]{64}$/.test(body.digest)) throw new Error('Invalid digest');
  if (!Array.isArray(body.files) || body.files.length < 2 || body.files.length > 2000) throw new Error('Invalid file count');
  const paths = new Set(); let total = 0;
  for (const file of body.files) {
    const path = file.path;
    if (typeof path !== 'string' || path.length > 512 || !/^(wrangler\.json|(?:worker|assets|migrations)\/[^\x00-\x1f\\]+)$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Invalid artifact path: ${path}`);
    if (paths.has(path)) throw new Error('Duplicate artifact path');
    paths.add(path);
    if (typeof file.data !== 'string') throw new Error('Invalid file encoding');
    const data = Buffer.from(file.data, 'base64');
    if (data.toString('base64') !== file.data) throw new Error('Invalid base64');
    total += data.length;
    if (total > MAX_UPLOAD) throw new Error('Artifact too large');
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), data, { flag: 'wx', mode: 0o600 });
  }
  const config = JSON.parse(await readFile(join(dir, 'wrangler.json'), 'utf8'));
  const canonical = translateConfig(config, body.app);
  if (typeof config.main !== 'string' || !paths.has(config.main) || !/^worker\/.*\.[cm]?js$/.test(config.main)) throw new Error('Invalid worker entry');
  canonical.main = config.main;
  if (!isDeepStrictEqual(config, canonical)) throw new Error('Noncanonical celld config');
  if (config.d1_databases.length > 1) throw new Error('Only one D1 database is supported');
  if ([...paths].filter(p => p.startsWith('worker/') && /\.[cm]?js$/.test(p)).length !== 1) throw new Error('Expected one JavaScript module');
  const migrations = []; const allowedMigrations = new Set();
  for (const db of config.d1_databases) {
    let previous = -1n;
    for (const path of [...paths].filter(p => p.startsWith(db.migrations_dir + '/')).sort()) {
      const name = path.slice(db.migrations_dir.length + 1);
      const match = /^(\d+)[_-][^/]+\.sql$/.exec(name);
      if (!match || BigInt(match[1]) <= previous) throw new Error('Invalid migration order/name');
      previous = BigInt(match[1]); allowedMigrations.add(path);
      migrations.push({ database: db.database_id, name, digest: createHash('sha256').update(await readFile(join(dir, path))).digest('hex') });
    }
  }
  for (const path of paths) if (path.startsWith('migrations/') && !allowedMigrations.has(path)) throw new Error('Unmapped migration');
  if (await artifactDigest(dir) !== body.digest) throw new Error('Artifact digest mismatch');
  return { app: body.app, digest: body.digest, resources: resourceIdentity(config), migrations };
}
