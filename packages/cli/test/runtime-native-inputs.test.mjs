import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { acquireNativeInputs, assertNativeLock, validateNativeInputs } from '../../../docker/runtime-native-inputs.mjs';

const exec = promisify(execFile);
const script = new URL('../../../docker/runtime-native-inputs.mjs', import.meta.url).pathname;
const version = '152.1.0', target = 'aarch64-unknown-linux-gnu', crate = 'c'.repeat(64), secret = 'SECRET-signed-token';
const release = `https://github.com/denoland/rusty_v8/releases/download/v${version}/`;
const bodies = { archive: Buffer.from('synthetic static archive\n'.repeat(4096)), bindings: Buffer.from('pub const SYNTHETIC: u32 = 1;\n') };
const urls = { archive: `${release}librusty_v8_release_${target}.a.gz`, bindings: `${release}src_binding_release_${target}.rs` };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const asset = name => ({ url: urls[name], sha256: sha256(bodies[name]), bytes: bodies[name].length });
const manifest = () => ({ schema: 1, target, v8Version: version, v8CrateSha256: crate, archive: asset('archive'), bindings: asset('bindings') });
const mode = async path => (await stat(path)).mode & 0o777;

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-native-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, out: join(root, 'out') };
}

// External HTTP boundary: each asset URL answers through a signed CDN redirect, like GitHub releases.
function github(overrides = {}) {
  const calls = [];
  const request = async (url, init) => {
    calls.push({ url, init });
    const name = Object.keys(urls).find(key => url === urls[key] || url.startsWith(`https://objects.githubusercontent.com/${key}?`));
    if (overrides[name]) return overrides[name](url, init);
    if (url === urls[name]) return new Response(null, { status: 302, headers: { location: `https://objects.githubusercontent.com/${name}?X-Amz-Signature=${secret}` } });
    return new Response(bodies[name]);
  };
  return { calls, request };
}

const expectedReceipt = () => ({
  schema: 1, kind: 'verified-native-inputs', target, v8Version: version, v8CrateSha256: crate,
  assets: { archive: { file: 'rusty-v8.a.gz', ...pick(asset('archive')) }, bindings: { file: 'rusty-v8-bindings.rs', ...pick(asset('bindings')) } },
  compiled: false, qualified: false,
});
const pick = ({ sha256, bytes }) => ({ sha256, bytes });

async function assertUnpublished(out, pending) {
  assert.deepEqual((await readdir(out)).sort(), pending.sort());
  for (const file of await readdir(out)) assert.ok(!(await readFile(join(out, file), 'utf8')).includes(secret));
}

async function rejectsPrivately(promise, message) {
  await assert.rejects(promise, error => {
    assert.match(error.message, message);
    assert.ok(!/SECRET|https?:|example/.test(error.message), error.message);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('acquires both assets into a new private directory with a private synced receipt', async t => {
  const { out } = await workspace(t), { calls, request } = github();
  const receipt = await acquireNativeInputs(manifest(), out, { request });
  assert.deepEqual(receipt, expectedReceipt());
  assert.deepEqual((await readdir(out)).sort(), ['receipt.json', 'rusty-v8-bindings.rs', 'rusty-v8.a.gz']);
  assert.deepEqual(await readFile(join(out, 'rusty-v8.a.gz')), bodies.archive);
  assert.deepEqual(await readFile(join(out, 'rusty-v8-bindings.rs')), bodies.bindings);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'receipt.json'), 'utf8')), receipt);
  assert.equal(await mode(out), 0o700);
  for (const file of await readdir(out)) assert.equal(await mode(join(out, file)), 0o600);
  assert.ok(!(await readFile(join(out, 'receipt.json'), 'utf8')).includes(secret));
  assert.deepEqual(calls.map(call => call.url.split('?')[0]), [urls.archive, 'https://objects.githubusercontent.com/archive', urls.bindings, 'https://objects.githubusercontent.com/bindings']);
  assert.ok(calls.every(({ init }) => init.redirect === 'manual' && init.signal instanceof AbortSignal && !('authorization' in init.headers)));
});

test('withholds HTTP failure bodies and leaves only the private partial directory', async t => {
  const { out } = await workspace(t);
  const { request } = github({ archive: () => new Response(`internal ${secret}`, { status: 500 }) });
  await rejectsPrivately(acquireNativeInputs(manifest(), out, { request }), /archive download returned HTTP 500/);
  await assertUnpublished(out, ['rusty-v8.a.gz.pending']);
  assert.equal((await stat(join(out, 'rusty-v8.a.gz.pending'))).size, 0);
});

test('refuses downgraded, foreign, credentialed, missing and looping redirects', async t => {
  const { root } = await workspace(t);
  const redirect = location => () => new Response(`body ${secret}`, { status: 302, headers: location ? { location } : {} });
  const cases = {
    downgrade: `http://objects.githubusercontent.com/archive?sig=${secret}`,
    foreign: `https://evil.example/archive?sig=${secret}`,
    lookalike: 'https://objects.githubusercontent.com.evil.example/archive',
    credentials: 'https://user:pass@objects.githubusercontent.com/archive',
    port: 'https://objects.githubusercontent.com:8443/archive',
    missing: null,
  };
  for (const [label, location] of Object.entries(cases)) {
    const out = join(root, label);
    await rejectsPrivately(acquireNativeInputs(manifest(), out, { request: github({ archive: redirect(location) }).request }), /archive download redirected to a disallowed location/);
    await assertUnpublished(out, ['rusty-v8.a.gz.pending']);
  }
  const loop = github({ archive: redirect(urls.archive) });
  await rejectsPrivately(acquireNativeInputs(manifest(), join(root, 'loop'), { request: loop.request }), /archive download exceeded 5 redirects/);
  assert.equal(loop.calls.length, 6);
});

test('a bindings hash mismatch publishes nothing even after the archive verified', async t => {
  const { out } = await workspace(t);
  const tampered = Buffer.from(bodies.bindings).fill(0x41);
  const { request } = github({ bindings: () => new Response(tampered) });
  await rejectsPrivately(acquireNativeInputs(manifest(), out, { request }), /bindings download does not match its pinned SHA-256/);
  await assertUnpublished(out, ['rusty-v8.a.gz.pending', 'rusty-v8-bindings.rs.pending']);
  assert.deepEqual(await readFile(join(out, 'rusty-v8.a.gz.pending')), bodies.archive);
});

test('rejects truncated bodies and stops oversized streams at the pinned size', async t => {
  const { root } = await workspace(t);
  const short = github({ archive: () => new Response(bodies.archive.subarray(1)) });
  await rejectsPrivately(acquireNativeInputs(manifest(), join(root, 'short'), { request: short.request }), /archive download is truncated/);
  let pulls = 0, cancelled = false;
  const endless = new ReadableStream({ pull: controller => { if (++pulls > 8) controller.close(); else controller.enqueue(new Uint8Array(65536)); }, cancel: () => { cancelled = true; } });
  const huge = github({ archive: () => new Response(endless, { headers: { 'content-length': String(bodies.archive.length) } }) });
  await rejectsPrivately(acquireNativeInputs(manifest(), join(root, 'huge'), { request: huge.request }), /archive download is larger than \d+ bytes/);
  assert.ok(cancelled && pulls < 10);
  assert.ok((await stat(join(root, 'huge', 'rusty-v8.a.gz.pending'))).size <= bodies.archive.length);
  await assertUnpublished(join(root, 'huge'), ['rusty-v8.a.gz.pending']);
});

test('absolute deadline bounds a fetch and a stalled read that ignore abort', { timeout: 5000 }, async t => {
  const { root } = await workspace(t);
  const hung = github({ archive: () => new Promise(() => {}) });
  let started = Date.now();
  await rejectsPrivately(acquireNativeInputs(manifest(), join(root, 'fetch'), { request: hung.request, timeoutMs: 100 }), /archive download timed out/);
  assert.ok(Date.now() - started < 5000);
  assert.equal(hung.calls[0].init.signal.aborted, true);

  let cancelled = false;
  const stalled = new ReadableStream({
    start: controller => controller.enqueue(new Uint8Array(16)),
    pull: () => new Promise(() => {}),
    cancel: () => { cancelled = true; return new Promise(() => {}); },
  });
  const slow = github({ archive: () => new Response(stalled) });
  started = Date.now();
  await rejectsPrivately(acquireNativeInputs(manifest(), join(root, 'read'), { request: slow.request, timeoutMs: 100 }), /archive download timed out/);
  assert.ok(Date.now() - started < 5000 && cancelled);
  await assertUnpublished(join(root, 'read'), ['rusty-v8.a.gz.pending']);
});

test('existing output is refused before any request and left untouched', async t => {
  const { out } = await workspace(t), { calls, request } = github();
  await mkdir(out);
  await writeFile(join(out, 'rusty-v8.a.gz'), 'user file');
  await assert.rejects(acquireNativeInputs(manifest(), out, { request }), /output directory already exists/);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(join(out, 'rusty-v8.a.gz'), 'utf8'), 'user file');
});

test('validates the exact manifest schema and returns a clone', async () => {
  const pinned = JSON.parse(await readFile(new URL('../../../docker/runtime-native-inputs.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateNativeInputs(pinned), pinned);
  const input = manifest(), clone = validateNativeInputs(input);
  clone.archive.bytes = 1;
  assert.deepEqual(input, manifest());
  const invalid = {
    document: m => ({ ...m, extra: true }), schema: m => ({ ...m, schema: 2 }), target: m => ({ ...m, target: 'x86_64-unknown-linux-gnu' }),
    v8Version: m => ({ ...m, v8Version: '152.01.0' }), v8CrateSha256: m => ({ ...m, v8CrateSha256: 'C'.repeat(64) }),
    'archive.sha256': m => ({ ...m, archive: { ...m.archive, sha256: 'a'.repeat(63) } }),
    'archive.bytes': m => ({ ...m, archive: { ...m.archive, bytes: 512 * 1024 * 1024 + 1 } }),
    'bindings.bytes': m => ({ ...m, bindings: { ...m.bindings, bytes: 1.5 } }),
    'archive.url': m => ({ ...m, archive: { ...m.archive, url: `${urls.archive}?x=1` } }),
    'bindings.url': m => ({ ...m, bindings: { ...m.bindings, url: urls.bindings.replace('https://', 'https://u:p@') } }),
    bindings: m => ({ ...m, bindings: { ...m.bindings, mirror: 'https://example.com' } }),
  };
  for (const [field, mutate] of Object.entries(invalid)) assert.throws(() => validateNativeInputs(mutate(manifest())), { message: `Native input manifest ${field} is invalid` });
  assert.throws(() => validateNativeInputs({ ...manifest(), v8Version: '152.2.0' }), /archive\.url is invalid/);
});

test('Cargo.lock must pin exactly one matching v8 crate', () => {
  const entry = (name, ver, checksum) => `[[package]]\nname = "${name}"\nversion = "${ver}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\ndependencies = [\n "bitflags",\n]\n`;
  const lock = (...entries) => `version = 4\n\n${entries.join('\n')}\n[metadata]\nname = "v8"\n`;
  assertNativeLock(lock(entry('bitflags', '2.0.0', 'b'.repeat(64)), entry('v8', version, crate)), manifest());
  assert.throws(() => assertNativeLock(lock(entry('bitflags', '2.0.0', crate)), manifest()), /exactly one v8 package, found 0/);
  assert.throws(() => assertNativeLock(lock(entry('v8', version, crate), entry('v8', '151.0.0', crate)), manifest()), /exactly one v8 package, found 2/);
  assert.throws(() => assertNativeLock(lock(entry('v8', version, crate)).replace('registry+https://github.com/rust-lang/crates.io-index', 'git+https://example.invalid/v8'), manifest()), /source must be the crates.io registry/);
  assert.throws(() => assertNativeLock(lock(entry('v8', '152.1.1', crate)), manifest()), /v8 version does not match/);
  assert.throws(() => assertNativeLock(lock(entry('v8', version, 'd'.repeat(64))), manifest()), /v8 checksum does not match/);
  assert.throws(() => assertNativeLock(lock(entry('v8', version, crate).replace('checksum', 'version = "1.0.0"\nchecksum')), manifest()), /not canonical/);
  assert.throws(() => assertNativeLock(lock(entry('v8', version, crate), `  [[package]]\nname = 'v8'\n`), manifest()), /not canonical/);
  assert.throws(() => assertNativeLock(lock(entry('v8', version, crate)), { ...manifest(), schema: 2 }), /schema is invalid/);
});

test('CLI reads a bounded regular manifest and prints only the receipt', { timeout: 15000 }, async t => {
  const { root, out } = await workspace(t);
  const file = join(root, 'manifest.json'), preload = join(root, 'preload.mjs');
  await writeFile(file, JSON.stringify(manifest()));
  const served = Object.fromEntries(Object.keys(urls).map(name => [urls[name], bodies[name].toString('base64')]));
  await writeFile(preload, `const served = ${JSON.stringify(served)};\nglobalThis.fetch = async url => new Response(Buffer.from(served[url], 'base64'));\n`);
  const { stdout } = await exec(process.execPath, ['--import', preload, script, file, out]);
  assert.deepEqual(JSON.parse(stdout), expectedReceipt());

  await symlink(file, join(root, 'link.json'));
  await exec('mkfifo', [join(root, 'fifo.json')]);
  for (const path of ['link.json', 'fifo.json']) {
    await assert.rejects(exec(process.execPath, [script, join(root, path), join(root, `out-${path}`)], { timeout: 5000 }), error => error.code === 1 && /bounded regular file/.test(error.stderr));
    await assert.rejects(stat(join(root, `out-${path}`)), { code: 'ENOENT' });
  }
  await assert.rejects(exec(process.execPath, [script, file]), error => error.code === 2 && /usage/.test(error.stderr));
});
