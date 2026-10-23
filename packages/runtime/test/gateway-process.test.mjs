import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { runDurableGateway } from '../src/gateway-process.mjs';
import { prepareDurableGateway } from '../src/gateway-durable-program.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const policy = () => ({ schema: 1, policy: { installation: 'a'.repeat(64), slots: ['slot-1', 'slot-2'] },
  slots: ['slot-1', 'slot-2'].map(id => ({ id, nodes: [`${id}-a`, `${id}-b`] })) });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-gateway-process-')); t.after(() => rm(root, { recursive: true, force: true }));
  const authorityPath = join(root, 'authority'), parent = join(root, 'runtime'); await mkdir(authorityPath); await mkdir(parent);
  const signals = new EventEmitter();
  return { root, options: { env: {}, authorityPath, parent, signals, readPolicy: async () => policy(), checkExecutable: async () => {} } };
}
function childProcess(t, script, options) {
  const child = spawn(process.execPath, ['-e', script], { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGKILL'); await closed; } });
  return child;
}
test('gateway uses only the installed policy, fixed binary and credential-free child environment', async t => {
  const f = await fixture(t); let actual, program, observed;
  const env = { AWS_SECRET_ACCESS_KEY: 'PRIVATE', FOGD_GATEWAY_TOKEN: 'PRIVATE', NODE_OPTIONS: 'PRIVATE', FOGD_LISTEN: '*:9999', FOGD_SLOTS: 'PRIVATE' };
  const result = await runDurableGateway({ ...f.options, env, spawnChild(binary, args, options) {
    actual = { binary, args, options }; program = args[1];
    const child = childProcess(t, `process.send({ env: process.env, config: require('node:fs').readFileSync(${JSON.stringify(program)}, 'utf8') }, () => process.exit(7))`, options);
    child.once('message', value => { observed = value; }); return child;
  } });
  assert.equal(result.code, 7); assert.equal(result.signal, null);
  assert.ok(actual.binary.endsWith('/packages/runtime/node_modules/workerd/bin/workerd'));
  assert.deepEqual(actual.args, ['serve', program]); assert.deepEqual(actual.options, { stdio: 'inherit', env: {} });
  assert.equal(observed.env.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(observed.env.FOGD_GATEWAY_TOKEN, undefined); assert.equal(observed.env.NODE_OPTIONS, undefined);
  assert.ok(observed.config.includes('address = "*:8080"')); assert.equal(observed.config.includes('9999'), false); assert.equal(observed.config.includes('PRIVATE'), false);
  assert.deepEqual(await readdir(f.options.parent), []); assert.deepEqual(await readdir(f.options.authorityPath), []);
  assert.equal(f.options.signals.listenerCount('SIGTERM'), 0); assert.equal(f.options.signals.listenerCount('SIGINT'), 0);
});
test('staged configuration remains present until the actual child closes, then is removed', { timeout: 15000 }, async t => {
  const f = await fixture(t), started = Promise.withResolvers(); let program;
  const running = runDurableGateway({ ...f.options, spawnChild(_binary, args, options) {
    program = args[1]; const child = childProcess(t, "process.on('message', () => process.exit(0)); process.send('ready')", options);
    started.resolve(once(child, 'message').then(() => child)); return child;
  } });
  const child = await Promise.race([started.promise, running.then(() => assert.fail('Child exited before becoming ready'))]), config = await readFile(program, 'utf8');
  assert.ok(config.includes('writable = false')); assert.ok(config.includes('address = "*:8080"'));
  assert.equal(config.includes('PRIVATE'), false); assert.equal(config.includes('CONTROLLER'), false);
  child.send('finish'); assert.equal((await running).code, 0);
  await assert.rejects(readFile(program), { code: 'ENOENT' });
});
for (const signal of ['SIGTERM', 'SIGINT']) test(`supervisor forwards ${signal}, awaits close and preserves signal failure status`, { timeout: 15000 }, async t => {
  const f = await fixture(t), started = Promise.withResolvers();
  const running = runDurableGateway({ ...f.options, spawnChild(_binary, _args, options) {
    const child = childProcess(t, "setInterval(() => {}, 1000); process.send('ready')", options);
    started.resolve(once(child, 'message')); return child;
  } });
  await Promise.race([started.promise, running.then(() => assert.fail('Child exited before becoming ready'))]);
  f.options.signals.emit(signal);
  const result = await running; assert.equal(result.signal, signal); assert.equal(result.code, signal === 'SIGTERM' ? 143 : 130);
  assert.deepEqual(await readdir(f.options.parent), []); assert.equal(f.options.signals.listenerCount(signal), 0);
});
test('a process error does not remove staged files until the live child actually closes', { timeout: 15000 }, async t => {
  const f = await fixture(t), started = Promise.withResolvers(); let program;
  const running = runDurableGateway({ ...f.options, spawnChild(_binary, args, options) {
    program = args[1]; const child = childProcess(t, "process.on('message', () => process.exit(0)); process.send('ready')", options);
    started.resolve(once(child, 'message').then(() => child)); return child;
  } });
  const child = await Promise.race([started.promise, running.then(() => assert.fail('Child exited before becoming ready'))]);
  child.emit('error', new Error('PRIVATE kill failure'));
  assert.ok((await readFile(program, 'utf8')).includes('writable = false'));
  const refused = assert.rejects(running, error => error.code === 'GATEWAY_PROCESS_FAILED' && !error.message.includes('PRIVATE') && !('cause' in error));
  child.send('finish'); await refused;
  assert.deepEqual(await readdir(f.options.parent), []); assert.equal(f.options.signals.listenerCount('SIGTERM'), 0);
});
test('spawn failure refuses and removes only its own staged program', async t => {
  const f = await fixture(t);
  const sibling = join(f.options.parent, 'gateway-other'); await mkdir(sibling); await writeFile(join(sibling, 'retained'), 'retained');
  await assert.rejects(runDurableGateway({ ...f.options, spawnChild() { return spawn(join(f.root, 'missing-workerd')); } }), { code: 'GATEWAY_PROCESS_FAILED' });
  assert.deepEqual(await readdir(f.options.parent), ['gateway-other']); assert.equal(await readFile(join(sibling, 'retained'), 'utf8'), 'retained');
  assert.deepEqual(await readdir(f.options.authorityPath), []);
  assert.equal(f.options.signals.listenerCount('SIGTERM'), 0);
});
test('shutdown during policy loading aborts before staging or spawning and releases handlers', async t => {
  const f = await fixture(t), started = Promise.withResolvers(), release = Promise.withResolvers(); let spawned = false;
  const running = runDurableGateway({ ...f.options, readPolicy() { started.resolve(); return release.promise; }, spawnChild() { spawned = true; throw new Error('unexpected spawn'); } });
  await started.promise; f.options.signals.emit('SIGTERM'); release.resolve(policy());
  assert.deepEqual(await running, { code: 143, signal: 'SIGTERM' }); assert.equal(spawned, false);
  assert.deepEqual(await readdir(f.options.parent), []); assert.equal(f.options.signals.listenerCount('SIGTERM'), 0);
});
test('shutdown during executable checking aborts before staging or spawning', async t => {
  const f = await fixture(t), started = Promise.withResolvers(), release = Promise.withResolvers(); let spawned = false;
  const running = runDurableGateway({ ...f.options, checkExecutable() { started.resolve(); return release.promise; }, spawnChild() { spawned = true; throw new Error('unexpected spawn'); } });
  await started.promise; f.options.signals.emit('SIGINT'); release.resolve();
  assert.deepEqual(await running, { code: 130, signal: 'SIGINT' }); assert.equal(spawned, false);
  assert.deepEqual(await readdir(f.options.parent), []);
});
test('TLS files stay private and present through delayed shutdown until actual close', { timeout: 15000 }, async t => {
  const f = await fixture(t), started = Promise.withResolvers();
  const key = join(f.root, 'key.pem'), cert = join(f.root, 'cert.pem'), pair = join(f.root, 'keypair.json');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost']);
  const tls = { key: await readFile(key, 'utf8'), cert: await readFile(cert, 'utf8') }; await writeFile(pair, JSON.stringify(tls), { mode: 0o600 });
  let directory;
  const running = runDurableGateway({ ...f.options, env: { FOGD_TLS: '1', FOGD_TLS_FILE: pair }, spawnChild(_binary, args, options) {
    directory = dirname(args[1]);
    const child = childProcess(t, "process.on('SIGTERM', () => process.send('held')); process.on('message', () => process.exit(0)); process.send('ready')", options);
    started.resolve(once(child, 'message').then(() => child)); return child;
  } });
  const child = await Promise.race([started.promise, running.then(() => assert.fail('Child exited before becoming ready'))]);
  const held = once(child, 'message'); f.options.signals.emit('SIGTERM'); assert.deepEqual(await held, ['held', undefined]);
  assert.equal((await stat(join(directory, 'key.pem'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'cert.pem'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(directory, 'key.pem'), 'utf8'), tls.key);
  assert.equal(await readFile(join(directory, 'cert.pem'), 'utf8'), tls.cert);
  child.send('finish'); assert.equal((await running).code, 0);
  assert.deepEqual(await readdir(f.options.parent), []); assert.equal(await readFile(pair, 'utf8'), JSON.stringify(tls));
});
test('real process SIGTERM during policy loading prevents any gateway spawn', { timeout: 15000 }, async t => {
  const module = new URL('../src/gateway-process.mjs', import.meta.url).href;
  const script = `import(${JSON.stringify(module)}).then(async ({ runDurableGateway }) => {
    const release = Promise.withResolvers();
    const running = runDurableGateway({ readPolicy() { process.send('ready'); return release.promise; },
      checkExecutable: async () => {}, spawnChild() { throw new Error('Unexpected gateway spawn'); } });
    process.once('SIGTERM', () => process.send('signal observed'));
    process.once('message', () => release.resolve(${JSON.stringify(policy())}));
    const result = await running; process.exitCode = result.code; process.disconnect();
  }).catch(() => { process.exitCode = 1; process.disconnect(); });`;
  const child = childProcess(t, script, { env: {} }), closed = once(child, 'close');
  assert.deepEqual(await once(child, 'message'), ['ready', undefined]);
  const signalled = once(child, 'message'); child.kill('SIGTERM'); assert.deepEqual(await signalled, ['signal observed', undefined]);
  child.send('release'); assert.deepEqual(await closed, [143, null]);
});
test('shutdown while preparation is pending removes the actual staged program without spawning', async t => {
  const f = await fixture(t), staged = Promise.withResolvers(), release = Promise.withResolvers(); let spawned = false;
  const running = runDurableGateway({ ...f.options, async prepareProgram(parent, options) {
    const program = await prepareDurableGateway(parent, options); staged.resolve(program); await release.promise; return program;
  }, spawnChild() { spawned = true; throw new Error('unexpected spawn'); } });
  const program = await staged.promise; assert.ok((await readFile(program.path, 'utf8')).includes('writable = false'));
  f.options.signals.emit('SIGTERM'); release.resolve();
  assert.deepEqual(await running, { code: 143, signal: 'SIGTERM' }); assert.equal(spawned, false);
  assert.deepEqual(await readdir(f.options.parent), []); assert.equal(f.options.signals.listenerCount('SIGTERM'), 0);
});
test('invalid policy or transport refuses before staging or spawning', async t => {
  const f = await fixture(t); let calls = 0;
  const spawnChild = () => { calls++; throw new Error('unexpected spawn'); };
  await assert.rejects(runDurableGateway({ ...f.options, spawnChild, readPolicy: async () => null }), { code: 'GATEWAY_POLICY_REFUSED' });
  await assert.rejects(runDurableGateway({ ...f.options, spawnChild, env: { FOGD_PROFILE: 'shared' } }), /requires TLS/);
  assert.equal(calls, 0); assert.deepEqual(await readdir(f.options.parent), []);
});
