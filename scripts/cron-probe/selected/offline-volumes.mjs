import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { regularFiles } from '../../../packages/runtime/src/artifact.mjs';

const directories = ['packages/cli/src', 'packages/runtime/src', 'packages/platform/src', 'scripts/cron-probe'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function offlineVolumeInputs(host, project, sourceFiles, capabilityFile, output, image) {
  const prefix = `fogd-offline-${randomBytes(8).toString('hex')}`, input = prefix + '-inputs', results = prefix + '-results', files = {};
  async function add(path, source) { const bytes = await readFile(source); files[path] = { data: bytes.toString('base64'), sha256: hash(bytes) }; }
  for (const path of Object.keys(sourceFiles)) await add('inputs/project/' + path, join(project, path));
  await add('inputs/capabilities.json', capabilityFile);
  for (const directory of directories) for (const path of await regularFiles(resolve(directory))) await add('program/' + directory + '/' + path, resolve(directory, path));
  for (const name of [input, results]) await host.run('docker', ['volume', 'create', '--label', `fogd.qualifier.project=${host.project}`, name]);
  const code = `import assert from'node:assert/strict';import{mkdir,writeFile,readFile}from'node:fs/promises';import{dirname}from'node:path';import{createHash}from'node:crypto';
let text='';for await(const part of process.stdin){text+=part;if(text.length>16777216)throw Error('Offline sources exceed limit');}const result={};
for(const[path,file]of Object.entries(JSON.parse(text))){assert.ok(/^[A-Za-z0-9._/-]+$/.test(path)&&!path.startsWith('/')&&!path.split('/').includes('..'));const bytes=Buffer.from(file.data,'base64');assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);await mkdir(dirname('/input/'+path),{recursive:true});await writeFile('/input/'+path,bytes,{flag:'wx',mode:0o444});result[path]=createHash('sha256').update(await readFile('/input/'+path)).digest('hex');}console.log(JSON.stringify(result));`;
  const staged = JSON.parse(await host.run('docker', ['run', '--rm', '-i', '--pull', 'never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${input},dst=/input,volume-nocopy`, '--entrypoint', '/usr/local/bin/node', image, '--input-type=module', '-e', code], { inputText: JSON.stringify(files) }));
  assert.deepEqual(staged, Object.fromEntries(Object.entries(files).map(([path, f]) => [path, f.sha256])));
  const mounts = [`type=volume,src=${input},dst=/source,volume-subpath=inputs,readonly,volume-nocopy`,
    ...directories.map(path => `type=volume,src=${input},dst=/app/${path},volume-subpath=program/${path},readonly,volume-nocopy`),
    `type=volume,src=${results},dst=/results,volume-nocopy`];
  const receipt = { input, results, sourceFiles: staged, sourceVolumesReadOnlyDuringBuild: true, hostBindMounts: false };
  await writeFile(join(output, 'engine-inputs.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { mounts, receipt };
}

export async function verifyOfflinePackageMetadata(host, image) {
  const paths = ['cli', 'runtime', 'platform'].map(name => `packages/${name}/package.json`);
  const code = "const fs=require('node:fs'),c=require('node:crypto');console.log(JSON.stringify(Object.fromEntries(" + JSON.stringify(paths) + ".map(p=>[p,c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')]))));";
  const actual = JSON.parse(await host.run('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--entrypoint', '/usr/local/bin/node', image, '-e', code]));
  for (const path of paths) assert.equal(actual[path], hash(await readFile(path)), 'Offline SDK package metadata differs');
  return actual;
}
