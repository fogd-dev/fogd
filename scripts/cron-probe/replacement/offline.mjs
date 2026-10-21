import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const exec = promisify(execFile);
const offlineImage = 'sha256:2a8c24a10fcbb8d0fc0ed2c85c78115fab537ec4ee3c5679bc6238c0be84d4cf';
export async function offlineReplacement(project, directory) {
  const image = offlineImage;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  await checkBuildBase(image);
  const output = resolve(directory); await mkdir(output, { mode: 0o700 });
  const mounts = [[resolve(project), '/source/project'], [output, '/results', false],
    [fileURLToPath(new URL('./offline-worker.mjs', import.meta.url)), '/app/scripts/cron-probe/replacement/offline-worker.mjs']];
  for (const name of ['cli', 'runtime', 'platform']) for (const path of ['src', 'package.json']) mounts.push([resolve(`packages/${name}/${path}`), `/app/packages/${name}/${path}`]);
  for (const name of ['scripts/native-build.mjs', 'scripts/cron-probe/native.mjs', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) mounts.push([resolve(name), `/app/${name}`]);
  const name = `fogd-m11c-offline-${randomBytes(5).toString('hex')}`;
  const args = ['run', '--rm', '--pull', 'never', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '2g', '--cpus', '2',
    '-e', 'VOID_REMOTE=0', '-e', 'WRANGLER_SEND_METRICS=false', ...mounts.flatMap(([source, target, readonly = true]) => ['--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`]),
    '--entrypoint', '/usr/local/bin/node', image, '/app/scripts/cron-probe/replacement/offline-worker.mjs'];
  await build(args, name, join(output, 'build.log'));
  const result = JSON.parse(await readFile(join(output, 'offline.json'), 'utf8'));
  assert.equal(result.network, 'none'); assert.equal(result.ordinaryAdmission, 'rejected');
  const record = { image, sourceMountedReadOnly: true, ...result,
    voidPatchSha256: hash(await readFile('patches/void@1.1.11.patch')), artifactDigest: await artifactDigest(join(output, 'artifact')) };
  await writeFile(join(output, 'verified.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  return { output: join(output, 'artifact'), config: result.config, verification: record };
}
async function build(args, name, log) {
  let stdout = '', stderr = '', failed = false;
  try { ({ stdout, stderr } = await exec('docker', args, { maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60000 })); }
  catch (error) { stdout = error.stdout || ''; stderr = error.stderr || ''; failed = true; }
  await writeFile(log, stdout + stderr, { mode: 0o600 });
  const remaining = (await execute('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])).trim();
  if (remaining) { await execute('docker', ['rm', '-f', name]); failed = true; }
  assert.equal(failed, false, 'Offline replacement build failed; inspect its private build.log');
}
async function checkBuildBase(image) {
  const paths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/void@1.1.11.patch', 'examples/refresh/package.json', ...['cli', 'runtime', 'platform'].map(name => `packages/${name}/package.json`)];
  const code = `import{readFile}from'node:fs/promises';console.log(JSON.stringify(Object.fromEntries(await Promise.all(${JSON.stringify(paths)}.map(async name=>[name,await readFile(name,'utf8')])))));`;
  const before = JSON.parse(await execute('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--entrypoint', '/usr/local/bin/node', image, '--input-type=module', '-e', code]));
  for (const name of paths) {
    const current = await readFile(name, 'utf8');
    if (['package.json', 'packages/platform/package.json'].includes(name)) {
      const old = JSON.parse(before[name]), actual = JSON.parse(current), field = name === 'package.json' ? 'scripts' : 'exports';
      delete old[field]; delete actual[field]; assert.deepEqual(actual, old, 'Offline dependency declarations differ from the checked image');
    } else assert.equal(hash(current), hash(before[name]), 'Offline dependency inputs differ from the checked image');
  }
}
