import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { composeLiteral } from '../src/recovery/bundle.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

const exec = promisify(execFile), cli = new URL('../bin/fogd.js', import.meta.url).pathname;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-stop-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.fogd/installations/original'), bin = join(root, 'bin');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(bin);
  const { source } = prebootFixture();
  for (const [name, service] of Object.entries(source.services)) service.image = name === 'minio' ? 'fogd-minio:local' : 'fogd-runtime:local';
  const { config } = freshRuntimePlan(source, runtimeFamilies()[0]);
  const file = join(directory, 'compose.json'); await writeFile(file, JSON.stringify(composeLiteral(config)), { mode: 0o600 });
  const containers = Object.keys(config.services).map((service, index) => ({ Id: String(index + 1).padStart(64, 'a'),
    Config: { Labels: { 'com.docker.compose.project': config.name, 'com.docker.compose.service': service } },
    State: { Running: service !== 'bucket-init', Restarting: false, Paused: false, ExitCode: 0, OOMKilled: false } }));
  const state = join(root, 'engine.json'), log = join(root, 'calls.jsonl'), driver = join(root, 'driver.mjs');
  await writeFile(state, JSON.stringify({ containers, volumes: Object.values(config.volumes).map(volume => volume.name) }));
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nexec "$FOGD_TEST_NODE" "$FOGD_TEST_DRIVER" "$@"\n', { mode: 0o700 });
  await writeFile(driver, `import{readFileSync,writeFileSync,appendFileSync}from'node:fs';const a=process.argv.slice(2),s=JSON.parse(readFileSync(process.env.FOGD_TEST_STATE));appendFileSync(process.env.FOGD_TEST_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='volume'&&a[1]==='ls')console.log(s.volumes.join('\\n'));
else if(a[0]==='ps')console.log(a.includes('-aq')?s.containers.map(c=>c.Id).join('\\n'):process.env.FOGD_TEST_FOREIGN_WRITER||'');
else if(a[0]==='inspect')console.log(JSON.stringify(s.containers.filter(c=>a.includes(c.Id))));
else if(a[0]==='compose'&&a.includes('stop')){if(process.env.FOGD_TEST_STOP_FAILURE)process.exit(91);for(const c of s.containers)if(a.slice(a.indexOf('stop')+1).includes(c.Config.Labels['com.docker.compose.service'])&&!process.env.FOGD_TEST_IGNORE_STOP){if(c.State.Running)c.State.ExitCode=c.Config.Labels['com.docker.compose.service']==='workerd'?1:0;c.State.Running=false;c.State.Restarting=false;c.State.Paused=false;}writeFileSync(process.env.FOGD_TEST_STATE,JSON.stringify(s));}
else process.exit(99);`);
  const env = { PATH: bin, HOME: root, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'must-not-be-created.env'),
    FOGD_COMPOSE_FILE: '/private/wrong-template', COMPOSE_PROJECT_NAME: 'wrong-project',
    FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: driver, FOGD_TEST_STATE: state, FOGD_TEST_LOG: log };
  return { root, directory, file, config, state, log, env,
    run: (args = ['--installation', 'original'], extra = {}) => exec(process.execPath, [cli, 'stop', ...args], { env: { ...env, ...extra }, timeout: 20000 }),
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) };
}
test('stop selects canonical configuration, preserves volumes and uses ordered Compose stop without building or credentials', async t => {
  const f = await fixture(t), before = await readFile(f.file), engine = JSON.parse(await readFile(f.state));
  const report = JSON.parse((await f.run()).stdout);
  assert.equal(report.project, 'original'); assert.equal(report.status, 'stopped'); assert.equal(report.backupCreated, false); assert.equal(report.durability, 'not-assessed');
  assert.deepEqual(report.retainedVolumes, engine.volumes.sort()); assert.deepEqual(report.missingVolumes, []);
  assert.equal(report.services.length, 8); assert.equal(report.services.find(row => row.service === 'workerd').exitCode, 1);
  const stops = (await f.calls()).filter(args => args[0] === 'compose');
  assert.deepEqual(stops.map(args => args.slice(args.indexOf('stop'))), [['stop', 'workerd', 'controller'], ['stop', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'], ['stop', 'minio', 'bucket-init']]);
  assert.ok(stops.every(args => args[args.indexOf('-f') + 1] === f.file && args[args.indexOf('-p') + 1] === 'original'));
  assert.ok((await f.calls()).every(args => ['volume', 'ps', 'inspect', 'compose'].includes(args[0])));
  assert.deepEqual(await readFile(f.file), before); await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
  const again = JSON.parse((await f.run()).stdout); assert.deepEqual(again, report);
});
test('an unfinished restoration can be stopped but remains fenced against startup', async t => {
  const f = await fixture(t), marker = join(f.directory, 'restore.pending.json'); await writeFile(marker, '{"pending":true}');
  assert.equal(JSON.parse((await f.run()).stdout).status, 'stopped');
  await assert.rejects(exec(process.execPath, [cli, 'up', '--installation', 'original'], { env: f.env }), /Restoration is incomplete/);
  assert.equal(await readFile(marker, 'utf8'), '{"pending":true}');
});
test('partial service and storage inventory can be stopped without recreating missing data', async t => {
  const f = await fixture(t), engine = JSON.parse(await readFile(f.state));
  engine.volumes = engine.volumes.filter(name => name !== 'original_bucket'); engine.containers = engine.containers.filter(c => c.Config.Labels['com.docker.compose.service'] !== 'minio');
  await writeFile(f.state, JSON.stringify(engine));
  const report = JSON.parse((await f.run()).stdout);
  assert.deepEqual(report.missingVolumes, ['original_bucket']); assert.equal(report.services.length, 7);
  assert.deepEqual(JSON.parse(await readFile(f.state)).volumes, engine.volumes);
  assert.equal((await f.calls()).some(args => args.some(value => ['create', 'up', 'run', 'build', 'pull', 'rm'].includes(value))), false);
});
test('unexpected project containers refuse before stopping anything', async t => {
  const f = await fixture(t), engine = JSON.parse(await readFile(f.state)); engine.containers[0].Config.Labels['com.docker.compose.service'] = 'unknown-service';
  await writeFile(f.state, JSON.stringify(engine)); await assert.rejects(f.run(), /Unexpected containers/);
  assert.equal((await f.calls()).some(args => args[0] === 'compose'), false); assert.deepEqual(JSON.parse(await readFile(f.state)), engine);
});
test('a stop command failure never reports the installation stopped', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(undefined, { FOGD_TEST_STOP_FAILURE: '1' }), error => error.code === 1 && /docker command failed/.test(error.stderr) && !error.stdout);
});
test('a surviving container or foreign writer prevents a false stopped report', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(undefined, { FOGD_TEST_IGNORE_STOP: '1' }), /Project still has running containers/);
  await assert.rejects(f.run(undefined, { FOGD_TEST_FOREIGN_WRITER: 'foreign-writer' }), /still has a running writer/);
});
for (const args of [[], ['original'], ['--installation', ''], ['--installation', 'missing'], ['--installation', 'original', '--force']]) test(`bad stop selection refuses before Docker: ${JSON.stringify(args)}`, async t => {
  const f = await fixture(t); await assert.rejects(f.run(args), { code: 1 }); await assert.rejects(access(f.log), { code: 'ENOENT' });
});
