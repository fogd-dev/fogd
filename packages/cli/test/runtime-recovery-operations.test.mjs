import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

const exec = promisify(execFile);
const moduleUrl = name => new URL(`../src/runtime/${name}.mjs`, import.meta.url).href;
const setup = `import assert from'node:assert/strict';import{writeFile,readFile,mkdir,symlink}from'node:fs/promises';import{join}from'node:path';
import{writeRuntimeConfiguration,installationDirectory}from ${JSON.stringify(moduleUrl('installation-state'))};
import{writeRecoverySources,writeRecoverySource,assertRecoveryOperationsAvailable}from ${JSON.stringify(moduleUrl('recovery-source'))};
import{acquireLaunchFence,acquireStopFence}from ${JSON.stringify(moduleUrl('launch-fence'))};
const config=${JSON.stringify(prebootFixture().source)};for(const name of ['current','retained','target','sibling','unrelated'])await writeRuntimeConfiguration({...config,name},{reserve:true});
await writeRecoverySources('target',[{project:'current',config},{project:'retained',config}]);await writeRecoverySource('sibling','current',config);
const identity=project=>({project,installation:'a'.repeat(64)}),marker=project=>join(installationDirectory(project),'launch.pending.json');`;
async function run(t, code) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-recovery-operations-')); t.after(() => rm(root, { recursive: true, force: true }));
  const result = await exec(process.execPath, ['--input-type=module', '-e', setup + code], { env: { ...process.env, FOGD_HOME: root }, timeout: 15000 });
  assert.equal(result.stdout.trim(), 'checked');
}

test('a transitive peer operation blocks the recovery graph without changing its marker', t => run(t, `
const peer=await acquireStopFence(installationDirectory('retained'),identity('retained')),before=await readFile(marker('retained'));
await assert.rejects(assertRecoveryOperationsAvailable('sibling',['sibling']),{code:'FENCE_EXISTS'});
assert.deepEqual(await readFile(marker('retained')),before);await peer.release();await assertRecoveryOperationsAvailable('sibling',['sibling']);console.log('checked');`));

test('owned source fences are excluded while another sibling remains a blocker', t => run(t, `
const current=await acquireStopFence(installationDirectory('current'),identity('current')),retained=await acquireStopFence(installationDirectory('retained'),identity('retained'));
await assertRecoveryOperationsAvailable('current',['current','retained']);
const sibling=await acquireLaunchFence(installationDirectory('sibling'),identity('sibling'));
await assert.rejects(assertRecoveryOperationsAvailable('current',['current','retained']),{code:'FENCE_EXISTS'});
await sibling.release();await current.release();await retained.release();console.log('checked');`));

test('an own fence must be explicitly owned; an unrelated pending operation has no effect', t => run(t, `
const own=await acquireLaunchFence(installationDirectory('sibling'),identity('sibling')),unrelated=await acquireStopFence(installationDirectory('unrelated'),identity('unrelated'));
await assert.rejects(assertRecoveryOperationsAvailable('sibling'),{code:'FENCE_EXISTS'});
await assertRecoveryOperationsAvailable('sibling',['sibling']);await own.release();await unrelated.release();console.log('checked');`));

for (const kind of ['partial', 'directory', 'symlink']) test(`${kind} peer marker refuses without reading or replacing it`, t => run(t, `
const path=marker('retained'),kind=${JSON.stringify(kind)};
if(kind==='directory')await mkdir(path);else if(kind==='symlink')await symlink('/unread-private-target',path);else await writeFile(path,'incomplete');
await assert.rejects(assertRecoveryOperationsAvailable('sibling',['sibling']),{code:'FENCE_EXISTS'});console.log('checked');`));
