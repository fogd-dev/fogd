import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from '../../packages/cli/src/recovery/execute.mjs';
import { runtimeFamily, verifyRuntimeFamily } from '../../packages/cli/src/runtime/catalog.mjs';
import { cleanupObserver } from '../../packages/cli/src/observe/cleanup.mjs';
import { startReader } from './reader-host.mjs';
import { publisherFacts } from './publisher-facts.mjs';
import { workerdExecutable } from './workerd-executable.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/serving-authority/check-disk.mjs NEW_PRIVATE_OUTPUT');
const output = resolve(process.argv[2]), root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(output, { mode: 0o700 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
let command = 0;
async function docker(args, options = {}) {
  const id = command++; await save(`command-${id}.json`, { args, inputText: options.inputText });
  const text = await execute('docker', args, { timeoutMs: 20000, ...options });
  await writeFile(join(output, `command-${id}.stdout`), text, { mode: 0o600 }); return text;
}
const json = async args => JSON.parse(await docker(args));
async function resources() {
  const result = {};
  for (const [key, args] of Object.entries({ containers: ['ps', '-aq'], volumes: ['volume', 'ls', '-q'], networks: ['network', 'ls', '-q'] })) result[key] = (await docker(args)).trim().split(/\s+/).filter(Boolean).sort();
  return result;
}
async function states(ids) {
  return ids.length ? (await docker(['inspect', '--format', '{{.Id}} {{.State.Running}} {{.State.Paused}} {{.State.Restarting}}', ...ids])).trim().split('\n').sort() : [];
}
const entry = runtimeFamily('celld-cron-v2-linux-arm64', 'enrolled');
const engine = await json(['info', '--format', '{{json .}}']);
const sourceCommit = (await execute('git', ['-C', root, 'rev-parse', 'HEAD'])).trim();
const sourceTreeDirty = Boolean((await execute('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'])).trim());
const before = await resources(), existingStates = await states(before.containers), sources = {};
await verifyRuntimeFamily(entry, docker);
const paths = (await execute('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'packages/cli', 'packages/runtime', 'packages/platform', 'scripts/serving-authority'])).split('\0').filter(Boolean);
for (const path of paths) {
  const bytes = await readFile(join(root, path)); sources[path] = hash(bytes);
  const target = join(output, 'executed-source', path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await copyFile(join(root, path), target);
}
await save('sources.json', sources); await save('resources-before.json', before); await save('states-before.json', existingStates);
const nonce = randomUUID(), volume = `fogd-route-disk-${nonce}`, writer = `fogd-route-writer-${nonce}`;
const readers = [`fogd-route-reader-${nonce}`, `fogd-route-restart-${nonce}`], names = [writer, ...readers];
const isolation = [ '--pull', 'never', '--label', `fogd.observer.id=${nonce}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--cpus', '0.5', '--memory', '256m', '--pids-limit', '128'];
const mount = readonly => ['--mount', `type=volume,src=${volume},dst=/authority${readonly ? ',readonly' : ''}`];
let reader, cleaned = false; const terminals = {}, executables = {};
try {
  assert.ok(!before.volumes.includes(volume));
  await docker(['volume', 'create', '--label', `fogd.route-probe.id=${nonce}`, volume]);
  const [created] = await json(['volume', 'inspect', volume]);
  assert.equal(created.Labels['fogd.route-probe.id'], nonce); assert.equal(created.Driver, 'local'); assert.deepEqual(created.Options || {}, {});
  await docker(['run', '-d', '--name', writer, ...isolation, ...mount(false), '--entrypoint', '/usr/local/bin/node', entry.image, '-e', 'setInterval(()=>{},1000)']);
  const filesystem = JSON.parse(await docker(['exec', writer, 'node', '-e', "const f=require('node:fs');console.log(JSON.stringify(f.statfsSync('/authority')))" ]));
  assert.ok((filesystem.frsize || filesystem.bsize) * filesystem.bavail > 8 * 1024 ** 2, 'Insufficient headroom for the bounded metadata experiment');
  await save('filesystem.json', filesystem);
  const workerdVersion = (await docker(['exec', writer, 'workerd', '--version'])).trim();
  await save('runtime.json', { image: entry.image, workerdVersion });
  async function publish(revision, state, slot) {
    const table = { revision, state, slot };
    const code = `import {saveJson} from '/app/packages/platform/src/store.mjs';await saveJson('/authority/routes.json',${JSON.stringify(table)});`;
    await writerScript(code);
  }
  const writerScript = code => docker(['exec', '-i', writer, 'node', '--input-type=module', '-'], { inputText: code });
  function readerArgs(name, mode) {
    return ['run', '-i', '--name', name, ...isolation, ...mount(true), '--mount', `type=bind,src=${join(root, 'scripts/serving-authority')},dst=/probe,readonly`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--entrypoint', '/usr/local/bin/node', entry.image, '/probe/disk-reader.mjs', mode];
  }
  reader = startReader(readerArgs(readers[0], 'initial'), join(output, 'reader.log'));
  executables.initial = await reader.executable();
  assert.equal(await reader.nextPhase(), 'missing'); await inspectHelpers([writer, readers[0]], 'initial');
  await publish(1, 'active', 'slot-1');
  await writerScript("import{writeFile}from'node:fs/promises';await writeFile('/authority/routes.json.interrupted.tmp','staging');");
  await reader.advance('missing');
  assert.equal(await reader.nextPhase(), 'held');
  await publish(2, 'paused', 'slot-1');
  await reader.advance('held');
  assert.equal(await reader.nextPhase(), 'paused');
  await publish(3, 'active', 'slot-2');
  await reader.advance('paused');
  assert.equal(await reader.nextPhase(), 'replacement');
  const facts = JSON.parse(await writerScript(`const executable=await (${workerdExecutable.toString()})();console.log(JSON.stringify(await (${publisherFacts.toString()})(executable)));`));
  assert.deepEqual(facts.files.map(file => file.name), ['routes.json', 'routes.json.interrupted.tmp']);
  assert.match(facts.workerdBinarySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(executables.initial, { path: facts.workerdExecutable, sha256: facts.workerdBinarySha256 });
  const sibling = facts.files.find(file => file.name.endsWith('.tmp'));
  assert.equal(sibling.bytes, 7); assert.equal(sibling.sha256, hash(Buffer.from('staging'))); await save('publisher-facts.json', facts);
  await docker(['stop', '--time', '1', writer]);
  const [stopped] = await json(['inspect', writer]);
  assert.equal(stopped.State.Running, false); assert.equal(stopped.State.Restarting, false); assert.equal(stopped.State.Paused, false);
  await save('publisher-stopped.json', { running: stopped.State.Running, exitCode: stopped.State.ExitCode });
  await reader.advance('replacement');
  const observed = await reader.result();
  assert.deepEqual(observed, { missingHTTPStatus: 404, putHTTPStatus: 405,
    active: { status: 200, value: { revision: 1, state: 'active', slot: 'slot-1' } },
    paused: { status: 200, value: { revision: 2, state: 'paused', slot: 'slot-1' } },
    earlier: { status: 200, value: { revision: 1, state: 'active', slot: 'slot-1' } },
    replacement: { status: 200, value: { revision: 3, state: 'active', slot: 'slot-2' } },
    afterStop: { status: 200, value: { revision: 3, state: 'active', slot: 'slot-2' } } });
  reader.endInput(); terminals.initial = await reader.finish(); assert.deepEqual(terminals.initial, { code: 0, signal: null, failure: undefined }); reader = null;
  const restarted = startReader(readerArgs(readers[1], 'restart'), join(output, 'restart.log')); reader = restarted;
  executables.restart = await reader.executable(); assert.deepEqual(executables.restart, executables.initial);
  assert.equal(await reader.nextPhase(), 'restart'); await inspectHelpers([readers[1]], 'restart'); await reader.advance('restart');
  const restart = await reader.result(); assert.deepEqual(restart, { record: { status: 200, value: { revision: 3, state: 'active', slot: 'slot-2' } } });
  reader.endInput(); terminals.restart = await reader.finish(); assert.deepEqual(terminals.restart, { code: 0, signal: null, failure: undefined }); reader = null;
  await save('observations.json', { observed, restart }); await save('reader-terminals.json', terminals); await save('reader-executables.json', executables);
  await cleanup(); cleaned = true;
  const after = await resources();
  assert.deepEqual(after.containers, before.containers); assert.deepEqual(after.networks, before.networks);
  assert.deepEqual(after.volumes, [...before.volumes, volume].sort()); assert.deepEqual(await states(before.containers), existingStates);
  for (const [path, digest] of Object.entries(sources)) assert.equal(hash(await readFile(join(root, path))), digest, 'Source changed during the native check');
  await save('resources-after.json', after);
  await save('result.json', { passed: true, scope: 'Linux Docker local-volume fresh-read mechanism only; not a serving implementation, power-loss durability, app/health/performance or new runtime-family qualification.',
    image: entry.image, volume, filesystemType: filesystem.type, filesystem: facts.filesystem, observed, restart,
    workerdBinarySha256: facts.workerdBinarySha256, sourceCommit, sourceTreeDirty,
    platform: { host: process.platform, operatingSystem: engine.OperatingSystem, kernelVersion: engine.KernelVersion, architecture: engine.Architecture, driver: engine.Driver },
    sourceFiles: Object.keys(sources).length, sourceInventorySha256: hash(await readFile(join(output, 'sources.json'))), existingContainerStatesPreserved: existingStates.length,
    existingResourcesPreserved: true, retainedProbeVolume: true, authorityFixtureBytes: facts.files.reduce((total, file) => total + file.bytes, 0) });
  console.log(JSON.stringify({ passed: true, output, volume, existingResourcesPreserved: true }));
} catch (error) {
  await save('failure.json', { message: error.message, stack: error.stack }); throw error;
} finally {
  reader?.kill();
  try { if (!cleaned) await cleanup(); }
  finally { if (reader) await save('failed-reader-terminal.json', await reader.finish()); }
}
async function cleanup() {
  const errors = [];
  for (const name of names) { try { await cleanupObserver(name, nonce); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, 'Probe helper cleanup is unconfirmed');
  await save('cleanup.json', { names, nonce, confirmed: true });
}
async function inspectHelpers(selection, label) {
  const helpers = await json(['inspect', ...selection]);
  assert.equal(helpers.length, selection.length);
  for (const helper of helpers) {
    assert.equal(helper.Image, entry.image); assert.equal(helper.Config.Labels['fogd.observer.id'], nonce);
    assert.equal(helper.HostConfig.NetworkMode, 'none'); assert.equal(helper.HostConfig.ReadonlyRootfs, true);
    assert.equal(helper.HostConfig.Privileged, false); assert.deepEqual(helper.HostConfig.CapDrop, ['ALL']);
    const authority = helper.Mounts.find(value => value.Destination === '/authority'); assert.equal(authority.Name, volume);
    assert.equal(authority.RW, helper.Name === '/' + writer); assert.equal(helper.Mounts.filter(value => value.Type === 'volume').length, 1);
    if (helper.Name !== '/' + writer) {
      assert.equal(helper.Mounts.length, 2);
      const source = helper.Mounts.find(value => value.Destination === '/probe');
      assert.equal(source.Type, 'bind'); assert.equal(source.RW, false);
      const expected = Object.fromEntries(Object.entries(sources).filter(([path]) => path.startsWith('scripts/serving-authority/')).map(([path, digest]) => [path.split('/').at(-1), digest]));
      const code = "const f=require('node:fs'),c=require('node:crypto');const files={};for(const name of f.readdirSync('/probe').sort())files[name]=c.createHash('sha256').update(f.readFileSync('/probe/'+name)).digest('hex');console.log(JSON.stringify(files));";
      const mounted = JSON.parse(await docker(['exec', helper.Id, 'node', '-e', code]));
      assert.deepEqual(mounted, expected); await save(`${label}-mounted-sources.json`, mounted);
      assert.deepEqual(helper.HostConfig.Tmpfs, { '/tmp': 'rw,noexec,nosuid,size=16m' });
    } else { assert.equal(helper.Mounts.length, 1); assert.equal(Object.keys(helper.HostConfig.Tmpfs || {}).length, 0); }
  }
  await save(`${label}-mounts.json`, helpers.map(value => ({ name: value.Name, image: value.Image, mounts: value.Mounts, network: value.HostConfig.NetworkMode, readonlyRoot: value.HostConfig.ReadonlyRootfs, tmpfs: value.HostConfig.Tmpfs })));
}
