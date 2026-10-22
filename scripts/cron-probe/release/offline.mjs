import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';
import { offlineImage, checkOfflineInputs, runOfflineBuild } from '../offline-build.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function offlineFixture(project, directory, cron = '* * * * *') {
  assert.ok(['* * * * *', '*/3 * * * *'].includes(cron), 'Unknown offline fixture schedule');
  const image = offlineImage;
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  await checkOfflineInputs(image);
  const output = resolve(directory); await mkdir(output, { mode: 0o700 });
  const mounts = [[resolve(project), '/source/project'], [output, '/results', false],
    [fileURLToPath(new URL('./offline-worker.mjs', import.meta.url)), '/app/scripts/cron-probe/release/offline-worker.mjs']];
  for (const name of ['cli', 'runtime', 'platform']) for (const path of ['src', 'package.json']) mounts.push([resolve(`packages/${name}/${path}`), `/app/packages/${name}/${path}`]);
  for (const name of ['scripts/native-build.mjs', 'scripts/cron-probe/native.mjs', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) mounts.push([resolve(name), `/app/${name}`]);
  mounts.push([resolve('scripts/cron-probe/offline-project.mjs'), '/app/scripts/cron-probe/offline-project.mjs']);
  const name = `fogd-m11c-offline-${randomBytes(5).toString('hex')}`;
  const args = ['run', '--rm', '--pull', 'never', '--name', name, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '2g', '--cpus', '2',
    '-e', `FOGD_FIXTURE_CRON=${cron}`, '-e', 'VOID_REMOTE=0', '-e', 'WRANGLER_SEND_METRICS=false', ...mounts.flatMap(([source, target, readonly = true]) => ['--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`]),
    '--entrypoint', '/usr/local/bin/node', image, '/app/scripts/cron-probe/release/offline-worker.mjs'];
  await runOfflineBuild(args, name, join(output, 'build.log'));
  const result = JSON.parse(await readFile(join(output, 'offline.json'), 'utf8'));
  assert.equal(result.network, 'none'); assert.equal(result.ordinaryAdmission, 'rejected');
  const record = { image, sourceMountedReadOnly: true, ...result,
    voidPatchSha256: hash(await readFile('patches/void@1.1.11.patch')), artifactDigest: await artifactDigest(join(output, 'artifact')) };
  await writeFile(join(output, 'verified.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  return { output: join(output, 'artifact'), config: result.config, verification: record };
}
