import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile), repo = fileURLToPath(new URL('../../../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
export async function transferFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-transfer-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source);
  for (const name of ['cli', 'platform', 'runtime']) {
    const target = join(source, 'packages', name); await mkdir(target, { recursive: true });
    for (const path of ['package.json', 'src']) await cp(join(repo, 'packages', name, path), join(target, path), { recursive: true });
    if (name === 'cli') await cp(join(repo, 'packages/cli/bin'), join(target, 'bin'), { recursive: true });
    else await cp(target, join(source, 'node_modules/@fogd', name), { recursive: true });
  }
  // Resolve the existing declared dependency through its workspace installation.
  await cp(join(repo, 'packages/runtime/node_modules/ignore'), join(source, 'node_modules/ignore'), { recursive: true, dereference: true });
  for (const name of ['package.json', 'compose.yaml', '.env.example', 'docs/offline-installation.md']) {
    await mkdir(join(source, name, '..'), { recursive: true }); await cp(join(repo, name), join(source, name));
  }
  const catalog = join(source, 'packages/cli/src/runtime/catalog.json'), entries = JSON.parse(await readFile(catalog, 'utf8'));
  const configs = ['runtime', 'storage'].map(role => JSON.stringify({ os: 'linux', architecture: 'arm64', config: { Labels: { role } } }));
  const ids = configs.map(value => hash(value)), entry = { ...entries[0], image: `sha256:${ids[0]}`, storageImage: `sha256:${ids[1]}` };
  await writeFile(catalog, JSON.stringify([entry], null, 2) + '\n');
  const archive = join(root, 'archive'); await mkdir(archive);
  await writeFile(join(archive, 'manifest.json'), JSON.stringify(ids.map(id => ({ Config: `${id}.json`, RepoTags: null, Layers: ['layer.tar'] }))));
  for (const [index, id] of ids.entries()) await writeFile(join(archive, `${id}.json`), configs[index]);
  await writeFile(join(archive, 'layer.tar'), 'fixture layer');
  const images = join(root, 'images.tar'); await exec('tar', ['-cf', images, '-C', archive, 'manifest.json', ...ids.map(id => `${id}.json`), 'layer.tar']);
  const bin = join(root, 'bin'), log = join(root, 'calls.jsonl'), driver = join(root, 'docker.mjs'); await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nexec "$FOGD_TEST_NODE" "$FOGD_TEST_DRIVER" "$@"\n', { mode: 0o700 });
  await writeFile(driver, `import{readFileSync,appendFileSync}from'node:fs';const a=process.argv.slice(2),e=JSON.parse(readFileSync(process.env.FOGD_TEST_CATALOG))[0];appendFileSync(process.env.FOGD_TEST_LOG,JSON.stringify(a)+'\\n');
    if(a[0]==='info')console.log(JSON.stringify({OSType:'linux',Architecture:process.env.FOGD_TEST_ARCH||'arm64',Driver:process.env.FOGD_TEST_STORE||'overlay2',DriverStatus:process.env.FOGD_TEST_STORE==='overlayfs'?[['driver-type','io.containerd.snapshotter.v1']]:[]}));
    else if(a[0]==='image'&&a[1]==='inspect')console.log(JSON.stringify([{Id:a[2],Os:'linux',Architecture:'arm64',Config:{WorkingDir:'/app',Env:['PATH=/usr/local/bin:/usr/bin:/bin']}}]));
    else if(a[0]==='image'&&a[1]==='save')process.stdout.write(readFileSync(process.env.FOGD_TEST_IMAGES));
    else if(a[0]==='image'&&a[1]==='load'){readFileSync(0);if(process.env.FOGD_TEST_MUTATE_MEMBER)appendFileSync(process.env.FOGD_TEST_MUTATE_MEMBER,'changed during load');console.log('Loaded fixture images');}
    else if(a[0]==='run')console.log(JSON.stringify(a.at(-1).includes('Runtime program must not be a symlink')?{binarySha256:e.binarySha256,supervisorSha256:e.supervisorSha256}:e.sourceFiles));
    else process.exit(99);`);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: driver,
    FOGD_TEST_CATALOG: catalog, FOGD_TEST_LOG: log, FOGD_TEST_IMAGES: images };
  const cli = join(source, 'packages/cli/bin/fogd.js'), bundle = join(root, 'bundle');
  const invoke = (args, extra = {}) => exec(process.execPath, [cli, 'runtime', ...args], { env: { ...env, ...extra }, timeout: 20000, maxBuffer: 1024 ** 2 });
  const exportBundle = async () => JSON.parse((await invoke(['export', bundle, '--runtime', entry.id])).stdout);
  return { root, source, catalog, images, archive, ids, entry, env, cli, bundle, log, invoke, exportBundle };
}
