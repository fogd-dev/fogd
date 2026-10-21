import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addedLayers } from './layers.mjs';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';

export async function buildSealedRuntime(directory, project, receipt, policy) {
  await dependencies(receipt);
  const context = join(directory, 'image'); await mkdir(context);
  const qualification = join(context, 'qualification'); await mkdir(qualification);
  for (const packageName of ['runtime', 'platform']) {
    const target = join(context, 'packages', packageName); await mkdir(target, { recursive: true });
    await cp(`packages/${packageName}/src`, join(target, 'src'), { recursive: true });
    await cp(`packages/${packageName}/package.json`, join(target, 'package.json'));
  }
  for (const name of ['backend.mjs', 'controller.mjs']) await cp(new URL(`./${name}`, import.meta.url), join(qualification, name));
  await cp(new URL('../../queue-probe/controller-artifact.mjs', import.meta.url), join(qualification, 'controller-artifact.mjs'));
  await writeFile(join(qualification, 'runtime-policy.json'), JSON.stringify(policy, null, 2) + '\n');
  const base = `fogd-runtime:${project}-base`, tag = `fogd-runtime:cron-sealed-${project}`;
  await execute('docker', ['tag', receipt.images.observer.id, base]);
  assert.equal((await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', base])).trim(), receipt.images.observer.id);
  const file = join(context, 'Dockerfile');
  await writeFile(file, `FROM ${base}\nCOPY packages/ /app/packages/\nCOPY qualification/ /app/qualification/\nLABEL io.fogd.qualification="sealed-cron-recovery"\n`);
  await execute('docker', ['build', '--quiet', '--network', 'none', '-f', file, '-t', tag, context]);
  const [image, parent] = JSON.parse(await execute('docker', ['image', 'inspect', tag, base]));
  assert.deepEqual(image.RootFS.Layers.slice(0, parent.RootFS.Layers.length), parent.RootFS.Layers);
  assert.equal(parent.Id, receipt.images.observer.id);
  const programs = {};
  for (const name of ['backend.mjs', 'controller.mjs', 'controller-artifact.mjs', 'runtime-policy.json']) programs[`/app/qualification/${name}`] = createHash('sha256').update(await readFile(join(qualification, name))).digest('hex');
  const layers = await addedLayers(context, image, parent);
  return { tag, image: image.Id, parent: parent.Id, programs, layers, dockerfileSha256: createHash('sha256').update(await readFile(file)).digest('hex') };
}

async function dependencies(receipt) {
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/runtime/package.json']) {
    const actual = createHash('sha256').update(await readFile(name)).digest('hex');
    assert.equal(actual, receipt.runtimePackaging.dependencyManifests[name], 'Requalify the dependency base before changing its manifests');
  }
  const source = await execute('docker', ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', '/usr/local/bin/node',
    receipt.images.observer.id, '--input-type=module', '-e', "import{readFile}from'node:fs/promises';console.log(await readFile('packages/platform/package.json','utf8'));"]);
  const before = JSON.parse(source), after = JSON.parse(await readFile('packages/platform/package.json', 'utf8'));
  delete before.exports; delete after.exports;
  assert.deepEqual(after, before, 'Only package exports may differ from the installed dependency base');
}
