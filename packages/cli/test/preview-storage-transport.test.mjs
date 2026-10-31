import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewStorageSSH } from '../src/preview/storage-transport.mjs';
import { previewStorageAdmissionOperation } from '../src/preview/storage.mjs';
import { execute } from '../src/recovery/execute.mjs';

const refused = { code: 'PREVIEW_STORAGE_TRANSPORT_REFUSED' };
async function fixture(t, fail = false) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-storage-ssh-')); t.after(() => rm(root, { recursive: true, force: true }));
  const tools = join(root, 'tools'), record = join(root, 'call.json'); await mkdir(tools);
  await writeFile(join(tools, 'ssh'), `#!${process.execPath}
import{writeFile}from'node:fs/promises';let input='';for await(const chunk of process.stdin)input+=chunk;await writeFile(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),input,env:Object.keys(process.env).filter(k=>k.startsWith('FOGD_')||k.startsWith('DOCKER_'))}));${fail ? "console.error('PRIVATE_REMOTE_DETAILS');process.exit(2);" : "console.log(JSON.stringify({ok:true,admission:{observed:true}}));"}`, { mode: 0o700 });
  for (const [key, value] of Object.entries({ PATH: tools, FOGD_ADMIN_PASSWORD: 'PRIVATE_SOURCE_PASSWORD', DOCKER_HOST: 'tcp://wrong-host' })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const runHost = previewStorageSSH('owned-linux');
  return { record, runHost, request: { action: 'admission', root: '/var/lib/owned-preview', engineId: 'owned-engine' } };
}

test('storage SSH sends the pinned worker over stdin to one explicit noninteractive alias', async t => {
  const f = await fixture(t), value = await previewStorageAdmissionOperation({ runHost: f.runHost }, f.request);
  assert.deepEqual(value, { observed: true });
  const call = JSON.parse(await readFile(f.record)), payload = JSON.parse(call.input);
  assert.deepEqual(call.env, []); assert.equal(call.args.at(-2), 'owned-linux');
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes']) assert.ok(call.args.includes(option));
  assert.ok(call.args.includes('-T')); assert.ok(call.args.includes('--'));
  assert.deepEqual(JSON.parse(payload.input), f.request); assert.ok(payload.worker.includes('def '));
  assert.ok(!call.args.at(-1).includes(payload.worker)); assert.ok(!call.input.includes('PRIVATE_SOURCE_PASSWORD'));
});

test('the exact SSH remote command parses into a fixed Python bootstrap and preserves input bytes', async t => {
  const originalPath = process.env.PATH, f = await fixture(t);
  await previewStorageAdmissionOperation({ runHost: f.runHost }, f.request);
  const call = JSON.parse(await readFile(f.record));
  const value = await execute('python3', ['-c', 'import io,json,shlex,sys;parts=shlex.split(json.load(sys.stdin)["command"]);assert parts[:4]==["sudo","-n","python3","-c"];assert len(parts)==5;sys.stdin=io.StringIO(json.dumps({"worker":"import json,sys;print(json.dumps(json.loads(sys.stdin.buffer.read())))","input":"{\\"proof\\":\\"quote and newline\\\\n\\"}"}));exec(parts[4])'], {
    env: { ...process.env, PATH: originalPath }, inputText: JSON.stringify({ command: call.args.at(-1) }),
  });
  assert.deepEqual(JSON.parse(value), { proof: 'quote and newline\n' });
});

test('storage SSH rejects option-like, shell and ambiguous aliases before a subprocess', () => {
  for (const alias of ['', '-oProxyCommand=bad', 'owner@host', 'host;command', 'host name', 'host\n', 'x'.repeat(129), undefined]) {
    assert.throws(() => previewStorageSSH(alias), refused);
  }
});

test('storage SSH refuses unpinned programs and missing JSON input without remote effects', async t => {
  const f = await fixture(t);
  for (const [args, options] of [[['sh', '-c', 'bad'], { inputText: '{}' }], [['python3', '-c', 'print(1)'], { inputText: '{}' }], [[], {}]]) {
    await assert.rejects(f.runHost(args, options), refused);
  }
  await assert.rejects(readFile(f.record), { code: 'ENOENT' });
});

test('unknown SSH results stay refused without leaking remote diagnostics or retrying', async t => {
  const f = await fixture(t, true);
  await assert.rejects(f.runHost(['python3', '-c', 'bad'], { inputText: '{}' }), refused);
  await assert.rejects(previewStorageAdmissionOperation({ runHost: f.runHost }, f.request), error => {
    assert.equal(error.code, 'PREVIEW_STORAGE_REFUSED'); assert.ok(!error.message.includes('PRIVATE_')); return true;
  });
  assert.ok((await readFile(f.record)).length > 0);
});
