import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addedLayers } from './layers.mjs';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { sealedPrograms } from './programs.mjs';

export async function buildSealedRuntime(directory, project, receipt, policy, kind = 'recovery') {
  const programSources = sealedPrograms(kind);
  await dependencies(receipt);
  const context = join(directory, 'image'); await mkdir(context);
  const qualification = join(context, 'qualification'); await mkdir(qualification);
  for (const packageName of ['runtime', 'platform']) {
    const target = join(context, 'packages', packageName); await mkdir(target, { recursive: true });
    await cp(`packages/${packageName}/src`, join(target, 'src'), { recursive: true });
    await cp(`packages/${packageName}/package.json`, join(target, 'package.json'));
  }
  const sourcePrograms = {};
  for (const [name, source] of Object.entries(programSources)) {
    assert.match(name, /^[a-z][a-z0-9-]*\.mjs$/);
    const path = relative(process.cwd(), fileURLToPath(source));
    assert.ok(path && !path.startsWith('../') && !isAbsolute(path), 'Qualification programs must come from the reviewed checkout');
    sourcePrograms[`/app/qualification/${name}`] = path;
    await cp(source, join(qualification, name));
  }
  await writeFile(join(qualification, 'runtime-policy.json'), JSON.stringify(policy, null, 2) + '\n');
  const base = `fogd-runtime:${project}-base`, tag = `fogd-runtime:cron-sealed-${project}`;
  await execute('docker', ['tag', receipt.images.observer.id, base]);
  assert.equal((await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', base])).trim(), receipt.images.observer.id);
  const file = join(context, 'Dockerfile');
  await writeFile(file, `FROM ${base}\nCOPY packages/ /app/packages/\nCOPY qualification/ /app/qualification/\nLABEL io.fogd.qualification="sealed-cron-${kind}"\n`);
  await execute('docker', ['build', '--quiet', '--network', 'none', '-f', file, '-t', tag, context]);
  const [image, parent] = JSON.parse(await execute('docker', ['image', 'inspect', tag, base]));
  assert.deepEqual(image.RootFS.Layers.slice(0, parent.RootFS.Layers.length), parent.RootFS.Layers);
  assert.equal(parent.Id, receipt.images.observer.id);
  const programs = {};
  for (const name of [...Object.keys(programSources), 'runtime-policy.json']) programs[`/app/qualification/${name}`] = createHash('sha256').update(await readFile(join(qualification, name))).digest('hex');
  for (const [name, source] of Object.entries(sourcePrograms)) assert.equal(programs[name], createHash('sha256').update(await readFile(source)).digest('hex'), 'Qualification source changed during the build');
  const layers = await addedLayers(context, image, parent, Object.keys(programs));
  return { tag, image: image.Id, parent: parent.Id, programs, sourcePrograms, layers, dockerfileSha256: createHash('sha256').update(await readFile(file)).digest('hex') };
}

async function dependencies(receipt) {
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/runtime/package.json']) {
    const actual = createHash('sha256').update(await readFile(name)).digest('hex');
    assert.equal(actual, receipt.runtimePackaging.dependencyManifests[name], 'Requalify the dependency base before changing its manifests');
  }
  const source = JSON.parse(await execute('docker', ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', '/usr/local/bin/node',
    receipt.images.observer.id, '--input-type=module', '-e', "import{readFile}from'node:fs/promises';const names=['package.json','packages/platform/package.json'];console.log(JSON.stringify(Object.fromEntries(await Promise.all(names.map(async name=>[name,await readFile(name,'utf8')])))));"]));
  for (const [name, ignored] of [['package.json', 'scripts'], ['packages/platform/package.json', 'exports']]) {
    assert.equal(createHash('sha256').update(source[name]).digest('hex'), receipt.runtimePackaging.dependencyManifests[name], 'Installed manifest differs from the checked dependency base');
    const before = JSON.parse(source[name]), after = JSON.parse(await readFile(name, 'utf8'));
    delete before[ignored]; delete after[ignored];
    assert.deepEqual(after, before, `Only ${ignored} may differ from the installed ${name}`);
  }
}
