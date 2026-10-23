#!/usr/bin/env node
// Standalone (Node built-ins only): downloads and verifies the pinned Rusty V8 inputs. Never executes downloaded bytes.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGET = 'aarch64-unknown-linux-gnu', RELEASES = 'https://github.com/denoland/rusty_v8/releases/download/';
const MAX_ASSET_BYTES = 512 * 1024 * 1024, MAX_REDIRECTS = 5, MANIFEST_LIMIT = 65536, MAX_TIMER_MS = 2 ** 31 - 1;
const HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SHA256 = /^[0-9a-f]{64}$/, VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ASSETS = {
  archive: { file: 'rusty-v8.a.gz', remote: `librusty_v8_release_${TARGET}.a.gz` },
  bindings: { file: 'rusty-v8-bindings.rs', remote: `src_binding_release_${TARGET}.rs` },
};
const NAMES = Object.keys(ASSETS);
const PRIVATE_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export class NativeInputError extends Error {}
NativeInputError.prototype.name = 'NativeInputError';

const check = (ok, field) => { if (!ok) throw new NativeInputError(`Native input manifest ${field} is invalid`); };
const officialUrl = (version, name) => `${RELEASES}v${version}/${ASSETS[name].remote}`;

function exactObject(value, keys, field) {
  const plain = value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  check(plain && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), field);
}

function validateAsset(value, name, version) {
  exactObject(value, ['url', 'sha256', 'bytes'], name);
  const { url, sha256, bytes } = value;
  check(url === officialUrl(version, name), `${name}.url`);
  check(typeof sha256 === 'string' && SHA256.test(sha256), `${name}.sha256`);
  check(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_ASSET_BYTES, `${name}.bytes`);
  return { url, sha256, bytes };
}

export function validateNativeInputs(manifest) {
  exactObject(manifest, ['schema', 'target', 'v8Version', 'v8CrateSha256', 'archive', 'bindings'], 'document');
  const { schema, target, v8Version, v8CrateSha256, archive, bindings } = manifest;
  check(schema === 1, 'schema');
  check(target === TARGET, 'target');
  check(typeof v8Version === 'string' && VERSION.test(v8Version), 'v8Version');
  check(typeof v8CrateSha256 === 'string' && SHA256.test(v8CrateSha256), 'v8CrateSha256');
  return { schema, target, v8Version, v8CrateSha256, archive: validateAsset(archive, 'archive', v8Version), bindings: validateAsset(bindings, 'bindings', v8Version) };
}

// Cargo writes one `key = "value"` per line; anything else for a scalar key is refused rather than interpreted.
function lockPackage(block) {
  const fields = new Map();
  for (const line of block.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const [, key, value] = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(line) ?? [];
    if (!key || key === 'dependencies') continue;
    const text = /^"([^"\\]*)"$/.exec(value)?.[1];
    if (text === undefined || fields.has(key)) throw new NativeInputError('Cargo.lock package entry is not canonical');
    fields.set(key, text);
  }
  return fields;
}

export function assertNativeLock(cargoLockText, manifest) {
  const { v8Version, v8CrateSha256 } = validateNativeInputs(manifest);
  if (typeof cargoLockText !== 'string') throw new NativeInputError('Cargo.lock must be text');
  const v8 = cargoLockText.split(/^\s*\[\[package\]\]\s*$/m).slice(1).map(lockPackage).filter(fields => fields.get('name') === 'v8');
  if (v8.length !== 1) throw new NativeInputError(`Cargo.lock must contain exactly one v8 package, found ${v8.length}`);
  if (v8[0].get('source') !== 'registry+https://github.com/rust-lang/crates.io-index') throw new NativeInputError('Cargo.lock v8 source must be the crates.io registry');
  if (v8[0].get('version') !== v8Version) throw new NativeInputError('Cargo.lock v8 version does not match the native input manifest');
  if (v8[0].get('checksum') !== v8CrateSha256) throw new NativeInputError('Cargo.lock v8 checksum does not match the native input manifest');
}

// Never awaited: a stalled cancel must not extend the deadline.
const quietly = run => { try { Promise.resolve(run()).catch(() => {}); } catch {} };

// Every network await races this absolute deadline; fetch/read may ignore the abort signal.
function deadline(timeoutMs, name) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new NativeInputError(`Rusty V8 ${name} download timed out`)); }, timeoutMs);
  });
  expired.catch(() => {});
  return { signal: controller.signal, within: promise => Promise.race([promise, expired]), clear: () => clearTimeout(timer) };
}

function redirectTarget(location, base, name) {
  let next = null;
  try { if (location) next = new URL(location, base); } catch {}
  if (!next || next.protocol !== 'https:' || next.username || next.password || next.port || !HOSTS.has(next.hostname))
    throw new NativeInputError(`Rusty V8 ${name} download redirected to a disallowed location`);
  return next.href;
}

async function follow(url, name, request, clock) {
  const init = { redirect: 'manual', credentials: 'omit', headers: { 'accept-encoding': 'identity' }, signal: clock.signal };
  for (let hops = 0; ; hops++) {
    const response = await clock.within(Promise.resolve().then(() => request(url, init)));
    if (response.status === 200) return response;
    quietly(() => response.body?.cancel());
    if (!REDIRECT_STATUSES.has(response.status)) throw new NativeInputError(`Rusty V8 ${name} download returned HTTP ${Number(response.status)}`);
    if (hops >= MAX_REDIRECTS) throw new NativeInputError(`Rusty V8 ${name} download exceeded ${MAX_REDIRECTS} redirects`);
    url = redirectTarget(response.headers.get('location'), url, name);
  }
}

async function writeAll(file, bytes) {
  for (let offset = 0; offset < bytes.byteLength;) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
    if (!(bytesWritten > 0)) throw new NativeInputError('Native input write made no progress');
    offset += bytesWritten;
  }
}

async function copyVerified(body, file, name, asset, clock) {
  const reader = body.getReader(), hash = createHash('sha256');
  let total = 0, step;
  try {
    while (!(step = await clock.within(reader.read())).done) {
      if (!(step.value instanceof Uint8Array)) throw new TypeError('non-byte chunk');
      total += step.value.byteLength;
      if (total > asset.bytes) throw new NativeInputError(`Rusty V8 ${name} download is larger than ${asset.bytes} bytes`);
      hash.update(step.value);
      await writeAll(file, step.value);
    }
  } finally { if (!step?.done) quietly(() => reader.cancel()); }
  if (total !== asset.bytes) throw new NativeInputError(`Rusty V8 ${name} download is truncated`);
  if (hash.digest('hex') !== asset.sha256) throw new NativeInputError(`Rusty V8 ${name} download does not match its pinned SHA-256`);
}

async function transfer(file, name, asset, request, timeoutMs) {
  const clock = deadline(timeoutMs, name);
  try {
    const response = await follow(asset.url, name, request, clock);
    await copyVerified(response.body, file, name, asset, clock);
  } catch (error) {
    // Remote bodies, URLs and transport errors never reach the caller.
    throw error instanceof NativeInputError ? error : new NativeInputError(`Rusty V8 ${name} download failed`);
  } finally { clock.clear(); }
}

async function writePrivate(path, write) {
  const file = await open(path, PRIVATE_FILE, 0o600);
  try { await file.chmod(0o600); await write(file); await file.sync(); } finally { await file.close(); }
}

async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

// link() refuses existing names, so publication never overwrites.
async function publish(path) {
  await link(`${path}.pending`, path);
  await unlink(`${path}.pending`);
}

export async function acquireNativeInputs(manifest, outputDirectory, { request = globalThis.fetch, timeoutMs = 120000 } = {}) {
  const inputs = validateNativeInputs(manifest);
  if (typeof request !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) throw new NativeInputError('Native input options are invalid');
  const directory = resolve(outputDirectory), path = name => join(directory, ASSETS[name].file);
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
    throw error.code === 'EEXIST' ? new NativeInputError('Native input output directory already exists') : error;
  }
  await chmod(directory, 0o700);
  for (const name of NAMES) await writePrivate(`${path(name)}.pending`, file => transfer(file, name, inputs[name], request, timeoutMs));
  for (const name of NAMES) await publish(path(name));
  const assets = Object.fromEntries(NAMES.map(name => [name, { file: ASSETS[name].file, sha256: inputs[name].sha256, bytes: inputs[name].bytes }]));
  const receipt = { schema: 1, kind: 'verified-native-inputs', target: inputs.target, v8Version: inputs.v8Version, v8CrateSha256: inputs.v8CrateSha256, assets, compiled: false, qualified: false };
  const receiptPath = join(directory, 'receipt.json');
  await writePrivate(`${receiptPath}.pending`, file => writeAll(file, Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)));
  await publish(receiptPath);
  await syncDirectory(directory);
  await syncDirectory(dirname(directory));
  return receipt;
}

async function readManifest(path) {
  const refuse = () => new NativeInputError('Native input manifest must be a bounded regular file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => { throw error.code === 'ELOOP' ? refuse() : error; });
  try {
    const info = await file.stat(), buffer = Buffer.alloc(MANIFEST_LIMIT + 1);
    if (!info.isFile() || info.size > MANIFEST_LIMIT) throw refuse();
    let length = 0;
    for (let bytesRead = 1; bytesRead > 0 && length < buffer.length; length += bytesRead) ({ bytesRead } = await file.read(buffer, length, buffer.length - length));
    if (length > MANIFEST_LIMIT) throw refuse();
    try { return JSON.parse(buffer.toString('utf8', 0, length)); } catch { throw new NativeInputError('Native input manifest is not valid JSON'); }
  } finally { await file.close(); }
}

async function main(args) {
  if (args.length !== 2) { console.error('usage: node runtime-native-inputs.mjs MANIFEST_JSON NEW_OUTPUT_DIRECTORY'); return 2; }
  try {
    console.log(JSON.stringify(await acquireNativeInputs(await readManifest(args[0]), args[1])));
    return 0;
  } catch (error) { console.error(error.message); return 1; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
