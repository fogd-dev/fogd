// Executed only in the fixed offline build image, with read-only source/code
// mounts and a private results mount. The produced native artifact is deployed.
import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../../../packages/cli/src/local.mjs';
import { stageArtifact } from '../../../packages/runtime/src/artifact.mjs';
import { offlineSourceHashes, copyOfflineProject, readableOfflineOutput } from '../offline-project.mjs';
import { stageRefresh } from '../native.mjs';

assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal), 'Offline build requires network none');
const cron = process.env.FOGD_FIXTURE_CRON;
assert.ok(['* * * * *', '*/3 * * * *'].includes(cron), 'Unknown offline fixture schedule');
const source = '/source/project', project = '/app/.fogd/sealed-release-project', output = '/results';
let failure;
try {
  const before = await offlineSourceHashes(source);
  await copyOfflineProject(source, project);
  await run('pnpm', ['run', 'typecheck'], { cwd: project });
  await run('pnpm', ['run', 'build'], { cwd: project });
  const managed = JSON.parse(await readFile(join(project, 'dist/ssr/wrangler.json'), 'utf8'));
  await cp(join(project, 'dist'), join(output, 'managed'), { recursive: true });
  const native = await stageRefresh(join(output, 'artifact'), project, [cron]);
  const fogd = JSON.parse(await readFile(join(project, 'dist/ssr/wrangler.json'), 'utf8'));
  assert.deepEqual(managed.triggers, { crons: [cron] }); assert.deepEqual(managed.triggers, fogd.triggers);
  assert.deepEqual(managed.secrets, { required: ['REFRESH_TOKEN'] }); assert.deepEqual(managed.secrets, fogd.secrets);
  await assert.rejects(stageArtifact({ projectDir: project, outputDir: join(output, 'rejected'), app: 'refresh' }), /Unsupported binding\/config: triggers/);
  await writeFile(join(native.output, 'wrangler.json'), JSON.stringify(native.config));
  assert.deepEqual(await offlineSourceHashes(source), before, 'Offline source changed during compilation');
  await writeFile(join(output, 'offline.json'), JSON.stringify({ network: 'none', sourceFiles: before, managed: { triggers: managed.triggers, secrets: managed.secrets }, fogd: { triggers: fogd.triggers, secrets: fogd.secrets }, config: native.config, ordinaryAdmission: 'rejected' }, null, 2) + '\n');
} catch (error) { failure = error; throw error; }
finally {
  try { await readableOfflineOutput(output); }
  catch (error) { throw failure ? new AggregateError([failure, error], 'Offline build and output permissions failed') : error; }
}
