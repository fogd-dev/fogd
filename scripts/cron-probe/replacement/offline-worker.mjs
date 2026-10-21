// Executed only in the fixed offline build image, with read-only source/code
// mounts and a private results mount. The produced native artifact is deployed.
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { cp, mkdir, readFile, writeFile, stat, chmod, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { run } from '../../../packages/cli/src/local.mjs';
import { regularFiles, stageArtifact } from '../../../packages/runtime/src/artifact.mjs';
import { stageRefresh } from '../native.mjs';

assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal), 'Offline build requires network none');
const source = '/source/project', project = '/app/.fogd/sealed-replacement-project', output = '/results';
const paths = ['package.json', 'vite.config.ts', 'void.config.ts', 'fogd.json', 'tsconfig.json', 'env.ts', 'db', 'routes', 'lib', 'crons'];
async function sourceHashes() {
  const hashes = {};
  for (const path of paths) {
    const files = (await stat(join(source, path))).isDirectory() ? (await regularFiles(join(source, path))).map(file => `${path}/${file}`) : [path];
    for (const file of files) hashes[file] = createHash('sha256').update(await readFile(join(source, file))).digest('hex');
  }
  return hashes;
}
async function permissions(path) {
  const info = await stat(path); await chmod(path, info.isDirectory() ? 0o755 : 0o644);
  if (info.isDirectory()) for (const name of await readdir(path)) await permissions(join(path, name));
}
try {
  const before = await sourceHashes();
  await mkdir(project, { recursive: true });
  for (const path of paths) await cp(join(source, path), join(project, path), { recursive: true });
  await symlink('/app/examples/refresh/node_modules', join(project, 'node_modules'), 'dir');
  await run('pnpm', ['run', 'typecheck'], { cwd: project });
  await run('pnpm', ['run', 'build'], { cwd: project });
  const managed = JSON.parse(await readFile(join(project, 'dist/ssr/wrangler.json'), 'utf8'));
  await cp(join(project, 'dist'), join(output, 'managed'), { recursive: true });
  const native = await stageRefresh(join(output, 'artifact'), project);
  const fogd = JSON.parse(await readFile(join(project, 'dist/ssr/wrangler.json'), 'utf8'));
  assert.deepEqual(managed.triggers, { crons: ['* * * * *'] }); assert.deepEqual(managed.triggers, fogd.triggers);
  assert.deepEqual(managed.secrets, { required: ['REFRESH_TOKEN'] }); assert.deepEqual(managed.secrets, fogd.secrets);
  await assert.rejects(stageArtifact({ projectDir: project, outputDir: join(output, 'rejected'), app: 'refresh' }), /Unsupported binding\/config: triggers/);
  await writeFile(join(native.output, 'wrangler.json'), JSON.stringify(native.config));
  assert.deepEqual(await sourceHashes(), before, 'Offline source changed during compilation');
  await writeFile(join(output, 'offline.json'), JSON.stringify({ network: 'none', sourceFiles: before, managed: { triggers: managed.triggers, secrets: managed.secrets }, fogd: { triggers: fogd.triggers, secrets: fogd.secrets }, config: native.config, ordinaryAdmission: 'rejected' }, null, 2) + '\n');
} finally { await permissions(output); }
