import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), module = new URL('../src/doctor/installation-tls.mjs', import.meta.url).href;
async function runTLS(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-doctor-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runner = join(root, 'run.mjs'), log = join(root, 'calls.json');
  await writeFile(runner, `import{inspectInstallationTLS}from ${JSON.stringify(module)};import{writeFile}from'node:fs/promises';
const calls=[],mode=process.argv[2];let exists=false;
const run=async(args,options)=>{calls.push({args,options});if(args[0]==='run'){if(mode==='failure'||mode==='cleanup-failure'){exists=true;throw Error('private-helper-diagnostic');}return mode==='extra-field'?'["private-response"]':'{"valid":true}';}if(args[0]==='ps'){if(mode==='cleanup-failure')throw Error('private-docker-error');return exists?'a'.repeat(64):'';}if(args[0]==='rm'){exists=false;return'';}throw Error('unexpected boundary call');};
try{await inspectInstallationTLS({project:'sample',entry:{image:'sha256:'+'b'.repeat(64)}},{volumes:[{role:'tls',mountpoint:'/var/lib/docker/volumes/sample_tls/_data'}]},run);console.log('verified');}catch(e){console.log(e.constructor.name);process.exitCode=1;}finally{await writeFile(process.argv[3],JSON.stringify(calls));}`);
  let result;
  try { result = await exec(process.execPath, [runner, mode, log], { env: { PATH: '' } }); }
  catch (error) { result = error; }
  return { result, calls: JSON.parse(await readFile(log, 'utf8')) };
}
test('TLS observation uses the verified image with only an existing read-only backing bind', async t => {
  const { result, calls } = await runTLS(t, 'success'); assert.equal(result.stdout, 'verified\n');
  const args = calls[0].args;
  assert.ok(args.includes('type=bind,src=/var/lib/docker/volumes/sample_tls/_data,dst=/tls,readonly'));
  assert.equal(args.some(value => value.startsWith('type=volume,')), false);
  assert.equal(args[args.indexOf('--pull') + 1], 'never'); assert.equal(args[args.indexOf('--network') + 1], 'none');
  assert.ok(args.includes('--read-only')); assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
  assert.equal(args.includes('--cap-add'), false); assert.ok(args.includes('sha256:' + 'b'.repeat(64)));
  assert.ok(calls.at(-1).args.some(value => value.startsWith('label=fogd.observer.id=')));
});
test('a failed TLS helper is removed only through its nonce-bound selection', async t => {
  const { result, calls } = await runTLS(t, 'failure'); assert.equal(result.code, 1);
  assert.deepEqual(calls.find(call => call.args[0] === 'rm').args, ['rm', '-f', 'a'.repeat(64)]);
  const creation = calls[0].args, label = creation.find(value => value.startsWith('fogd.observer.id='));
  assert.ok(calls.filter(call => call.args[0] === 'ps').every(call => call.args.includes('label=' + label)));
  assert.ok(!result.stdout.includes('private-')); assert.equal(result.stderr, '');
});
test('unconfirmed TLS helper cleanup remains a fatal observation error', async t => {
  const { result } = await runTLS(t, 'cleanup-failure'); assert.equal(result.code, 1); assert.equal(result.stdout, 'ObserverCleanupError\n');
});
test('a malformed TLS observation cannot report a verified keypair', async t => {
  const { result } = await runTLS(t, 'extra-field'); assert.equal(result.code, 1); assert.equal(result.stdout, 'Error\n');
});
