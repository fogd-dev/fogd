import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyBundle } from '../../../packages/cli/src/recovery/bundle.mjs';
import { restoreInstallation } from '../../../packages/cli/src/recovery/restore.mjs';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';

const exec = promisify(execFile);
export async function realBundleNegatives(source, point, suffix) {
  if (suffix !== 'a') return;
  const bundle = await verifyBundle(point.directory), results = [];
  const root = join(source.file, '..');
  const closed = `${source.project}-ordinary-refusal`, closedOutput = join(root, 'ordinary-refusal');
  await assert.rejects(exec(process.execPath, ['packages/cli/bin/fogd.js', 'restore', point.directory, '--project', closed, '--output', closedOutput], { env: source.env }),
    error => error.code === 1 && /matching independently checked runtime profile/.test(error.stderr));
  await assertEmptyTarget(closed, closedOutput); results.push({ case: 'ordinary-cli', refused: true, noTargetResources: true });
  const wrong = `${source.project}-binary-refusal`, wrongOutput = join(root, 'binary-refusal');
  const policy = { ...source.runtimeProfile, binarySha256: '0'.repeat(64) };
  await assert.rejects(restoreInstallation({ ...bundle, dir: point.directory }, wrong, wrongOutput, null, policy), /Scheduled runtime preboot verification failed/);
  await assertEmptyTarget(wrong, wrongOutput); results.push({ case: 'wrong-native-digest', refused: true, noTargetResources: true });
  source.restoreRefusals = results; await source.save('real-bundle-refusals', results);
}
async function assertEmptyTarget(project, directory) {
  assert.equal((await projectContainers(project)).length, 0);
  for (const kind of ['volume', 'network']) assert.equal((await execute('docker', [kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).trim(), '');
  await assert.rejects(access(directory), { code: 'ENOENT' });
}
