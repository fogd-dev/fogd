import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { regularFiles } from '../../../packages/runtime/src/artifact.mjs';
import { stackRoot } from '../../../packages/cli/src/local.mjs';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';

const binary = 'b09c1cf0dabeac77a8d5bd96afb0ec24de22e6e452ae8ef97079d289b481eb70';
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
async function sources(directories, files = []) {
  const paths = [...files];
  for (const directory of directories) for (const file of await regularFiles(join(stackRoot, directory))) paths.push(`${directory}/${file}`);
  return Object.fromEntries(await Promise.all(paths.sort().map(async file => [file, await digest(join(stackRoot, file))])));
}
export async function provenance(image) {
  assert.match(image, /^fogd-runtime:cron-recovery-candidate[0-9]+$/);
  const [info] = JSON.parse(await execute('docker', ['image', 'inspect', image]));
  const platform = await sources(['packages/platform/src', 'packages/runtime/src']);
  const listing = JSON.parse(await execute('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', info.Id, 'node', '--input-type=module', '-e', "import{regularFiles}from'./packages/runtime/src/artifact.mjs';const files=[];for(const dir of ['packages/platform/src','packages/runtime/src'])for(const file of await regularFiles(dir))files.push(dir+'/'+file);console.log(JSON.stringify(files.sort()));"]));
  assert.deepEqual(listing, Object.keys(platform), 'Image contains missing or extra platform/runtime modules');
  const output = await execute('docker', ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', info.Id, 'sha256sum', '/usr/local/bin/celld', ...Object.keys(platform)]);
  const hashes = Object.fromEntries(output.trim().split('\n').map(line => { const [sha, path] = line.trim().split(/\s+/); return [path, sha]; }));
  assert.equal(hashes['/usr/local/bin/celld'], binary, 'Use the independently qualified native control candidate');
  delete hashes['/usr/local/bin/celld']; assert.deepEqual(hashes, platform, 'Image source must match the checked-out controller/runtime');
  return { image: info.Id, architecture: info.Architecture, os: info.Os, binary, platform, probe: await probeSources(), git: await gitState() };
}
async function probeSources() {
  const tracked = await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'examples/imports', 'examples/refresh']);
  const apps = tracked.split('\0').filter(Boolean);
  return sources(['scripts/cron-probe/recovery', 'scripts/cron-probe/faults', 'packages/cli/src', 'packages/cli/bin'], [...apps,
    'scripts/cron-recovery.mjs', 'scripts/queue-probe/controller-artifact.mjs', 'scripts/native-build.mjs',
    'scripts/cron-probe/records.mjs', 'scripts/cron-probe/vm-time.mjs', 'scripts/cron-probe/minute.mjs', 'scripts/cron-probe/refresh-project.mjs',
    'scripts/platform-client.mjs', 'scripts/guestbook-browser.mjs', 'scripts/http.mjs',
    'package.json', 'pnpm-lock.yaml', 'packages/cli/package.json', 'packages/platform/package.json', 'packages/runtime/package.json', 'docker/runtime.Dockerfile', 'docker/celld-supervisor.sh']);
}
async function gitState() { return { head: (await execute('git', ['rev-parse', 'HEAD'])).trim(), status: (await execute('git', ['status', '--short'])).trim() }; }
export async function verifyFinalProvenance(before) {
  assert.deepEqual(await sources(['packages/platform/src', 'packages/runtime/src']), before.platform, 'Platform sources changed during qualification');
  assert.deepEqual(await probeSources(), before.probe, 'Probe sources changed during qualification');
  before.finalGit = await gitState();
}
export async function verifyRunner(probe, directory) {
  const expected = await Promise.all(['controller.mjs', 'controller-artifact.mjs'].map(async file => [file, await digest(join(directory, file))]));
  const output = await probe.compose(['exec', '-T', 'controller', 'sha256sum', ...expected.map(([file]) => `/var/lib/fogd/qualification/${file}`)]);
  assert.deepEqual(output.trim().split('\n').map(line => line.trim().split(/\s+/)[0]), expected.map(([, sha]) => sha), 'Controller-volume qualification code differs from its recorded source');
}
