import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareBuildContext } from './runtime-build-context.mjs';
import { prepareRuntimeSource } from './runtime-source.mjs';
import { buildSourceRuntime } from './build-source-runtime.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { captureProcess } from '../packages/cli/src/logs/capture.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, env }).toString().trim();
const digest = character => character.repeat(64);
const inputs = { schema: 1, platform: 'linux/arm64', rustImage: `docker.io/library/rust:1.98.1-bookworm@sha256:${digest('a')}`, nodeImage: `docker.io/library/node:26.2.0-bookworm-slim@sha256:${digest('b')}` };
const template = 'FROM --platform=linux/arm64 @@RUST_IMAGE@@ AS native\nCOPY native/ /src/\nRUN cargo build --release --locked\nFROM @@NODE_IMAGE@@\nCOPY --from=native /src/target/release/celld /usr/local/bin/celld\n';
const nativeLock = 'version = 4\n\n[[package]]\nname = \"v8\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nversion = \"152.1.0\"\nchecksum = \"' + digest('e') + '\"\n';
const nativeInputs = { schema: 1, target: 'aarch64-unknown-linux-gnu', v8Version: '152.1.0', v8CrateSha256: digest('e'),
  archive: { url: 'https://github.com/denoland/rusty_v8/releases/download/v152.1.0/librusty_v8_release_aarch64-unknown-linux-gnu.a.gz', sha256: digest('d'), bytes: 3 },
  bindings: { url: 'https://github.com/denoland/rusty_v8/releases/download/v152.1.0/src_binding_release_aarch64-unknown-linux-gnu.rs', sha256: digest('f'), bytes: 4 } };
const native = { 'Cargo.lock': [nativeLock, '644'], 'build.sh': ['#!/bin/sh\n', '755'], 'src/main.rs': ['fn main() {}\n', '644'], 'assets/blob.bin': [Buffer.from([0, 255, 10, 13, 0]), '644'] };
const production = {
  'package.json': ['{"name":"fogd-workspace"}\n', '644'], 'pnpm-lock.yaml': ['lockfileVersion: 9.0\n', '644'],
  'pnpm-workspace.yaml': ["packages:\n  - packages/*\npatchedDependencies:\n  void@1.1.11: patches/void@1.1.11.patch\n", '644'],
  'patches/void@1.1.11.patch': ['void patch\n', '644'], 'docker/runtime-tools/package.json': ['{"dependencies":{"pnpm":"10.16.1"}}\n', '644'],
  'docker/runtime-tools/package-lock.json': ['{"lockfileVersion":3}\n', '644'],
  'docker/runtime-native-inputs.json': [JSON.stringify(nativeInputs), '644'],
  'docker/runtime-native-inputs.mjs': ['export const acquire = true;\n', '644'],
  'docker/runtime-workerd.mjs': ['export const workerd = true;\n', '644'], 'docker/celld-supervisor.sh': ['#!/bin/sh\nexec celld\n', '755'],
  'packages/platform/package.json': ['{"name":"@fogd/platform"}\n', '644'], 'packages/platform/src/index.mjs': ['export const platform = 1;\n', '644'],
  'packages/runtime/package.json': ['{"name":"@fogd/runtime"}\n', '644'], 'packages/runtime/src/serve.mjs': ['export const serve = 1;\n', '644'],
  'packages/runtime/src/wasm/blob.wasm': [Buffer.from([0, 97, 115, 109, 255]), '644'],
};
const privateFiles = ['.env', 'notes.txt', 'packages/runtime/test/serve.test.mjs', 'packages/runtime/node_modules/dep/index.js', 'packages/cli/src/cli.mjs', 'patches/native.patch', 'docker/runtime.Dockerfile'];

async function put(base, files) {
  for (const [path, [bytes, mode]] of Object.entries(files)) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), bytes, { mode: mode === '755' ? 0o755 : 0o644 });
  }
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'runtime-build-context-'));
  const repository = join(base, 'celld'), root = join(base, 'fogd'), prepared = join(base, 'prepared');
  await put(repository, native); git(repository, 'init', '-q'); git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'pinned');
  await put(root, { ...production, 'docker/runtime-source.Dockerfile': [template, '644'], ...Object.fromEntries(privateFiles.map(path => [path, ['private\n', '644']])) });
  const manifest = { schema: 1, repository: 'https://example.invalid/celld.git', revision: git(repository, 'rev-parse', 'HEAD'), cargoLockSha256: sha256(native['Cargo.lock'][0]),
    patches: [], sourceInventorySha256: inventory(native) };
  await prepareRuntimeSource({ repository, output: prepared, manifest, patchRoot: root });
  return { base, root, prepared, manifest, inputs, output: join(base, 'out') };
}

function inventory(files) {
  return sha256(Object.keys(files).sort().map(path => `${sha256(files[path][0])} ${files[path][1]}  ${path}\n`).join(''));
}

async function listing(directory) {
  const files = {};
  for (const path of (await readdir(directory, { recursive: true })).sort()) {
    const info = await lstat(join(directory, path));
    if (!info.isDirectory()) files[path] = [await readFile(join(directory, path)), info.mode & 0o111 ? '755' : '644'];
  }
  return files;
}

const expectedContext = () => ({ ...production, ...Object.fromEntries(Object.entries(native).map(([path, file]) => [`native/${path}`, file])),
  Dockerfile: [template.replace('@@RUST_IMAGE@@', inputs.rustImage).replace('@@NODE_IMAGE@@', inputs.nodeImage), '644'] });

async function copyPrepared(f, mutate) {
  const prepared = join(await mkdtemp(join(f.base, 'mutated-')), 'prepared');
  await cp(f.prepared, prepared, { recursive: true });
  await mutate(prepared);
  return { ...f, prepared };
}

test('assembles the exact production context and binds it in a final receipt', async () => {
  const f = await fixture();
  const receipt = await prepareBuildContext(f);
  const expected = expectedContext();
  const actual = await listing(join(f.output, 'context'));
  assert.deepEqual(Object.keys(actual), Object.keys(expected).sort());
  for (const [path, [bytes, mode]] of Object.entries(expected)) assert.deepEqual(actual[path], [Buffer.from(bytes), mode], path);
  for (const path of ['', 'native/src', 'packages/runtime/src/wasm/blob.wasm', 'docker/celld-supervisor.sh']) {
    assert.equal((await lstat(join(f.output, 'context', path))).mtimeMs, 0, path);
  }
  assert.equal((await lstat(join(f.output, 'context/native/src'))).mode & 0o777, 0o755);
  assert.match(actual.Dockerfile[0].toString(), new RegExp(`^FROM --platform=linux/arm64 ${inputs.rustImage} AS native\n[^]*\nFROM ${inputs.nodeImage}\n`));
  assert.deepEqual((await readdir(f.output)).sort(), ['context', 'receipt.json']);
  const pick = paths => Object.fromEntries(paths.map(path => [path, sha256(production[path][0])]));
  assert.deepEqual(receipt, { schema: 1, complete: true, platform: 'linux/arm64', rustImage: inputs.rustImage, nodeImage: inputs.nodeImage,
    native: { repository: f.manifest.repository, revision: f.manifest.revision, cargoLockSha256: f.manifest.cargoLockSha256, patches: [], sourceFiles: 4, sourceInventorySha256: f.manifest.sourceInventorySha256 },
    programFiles: pick(Object.keys(production).filter(path => path.startsWith('packages/')).sort()),
    rootFiles: pick(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/void@1.1.11.patch', 'docker/runtime-tools/package.json', 'docker/runtime-tools/package-lock.json', 'docker/celld-supervisor.sh', 'docker/runtime-native-inputs.json', 'docker/runtime-native-inputs.mjs', 'docker/runtime-workerd.mjs']),
    templateSha256: sha256(template), dockerfileSha256: sha256(expected.Dockerfile[0]), contextFiles: Object.keys(expected).length, contextInventorySha256: inventory(expected), built: false, qualified: false });
  assert.deepEqual(JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8')), receipt);
});

test('prepared source is re-verified and altered trees or receipts refuse before output', async () => {
  const f = await fixture();
  const receiptPath = prepared => join(prepared, 'receipt.json');
  const editReceipt = change => async prepared => writeFile(receiptPath(prepared), JSON.stringify({ ...JSON.parse(await readFile(receiptPath(prepared))), ...change }));
  const cases = [
    [prepared => writeFile(join(prepared, 'failure.json'), '{}'), /only receipt.json and source/],
    [prepared => rm(receiptPath(prepared)), /only receipt.json and source/],
    [editReceipt({ complete: false }), /receipt does not match/], [editReceipt({ compiled: true }), /receipt does not match/],
    [editReceipt({ qualified: true }), /receipt does not match/], [editReceipt({ revision: 'f'.repeat(40) }), /receipt does not match/],
    [editReceipt({ extra: 1 }), /receipt does not match/], [editReceipt({ pad: 'x'.repeat(70000) }), /bounded regular file/],
    [async prepared => { await rm(receiptPath(prepared)); await symlink(receiptPath(f.prepared), receiptPath(prepared)); }, /ELOOP/],
    [prepared => writeFile(join(prepared, 'source/src/main.rs'), 'fn main() { evil() }\n'), /tree does not match/],
    [prepared => writeFile(join(prepared, 'source/Cargo.lock'), 'version = 3\n'), /tree does not match/],
    [prepared => writeFile(join(prepared, 'source/extra.rs'), ''), /tree does not match/],
    [prepared => chmod(join(prepared, 'source/build.sh'), 0o644), /tree does not match/],
    [prepared => symlink('/etc/passwd', join(prepared, 'source/link')), /unsafe entry link/],
  ];
  for (const [mutate, error] of cases) {
    const g = await copyPrepared(f, mutate);
    await assert.rejects(prepareBuildContext(g), error);
    assert.equal(existsSync(g.output), false);
  }
  const aliased = join(f.base, 'aliased');
  await symlink(f.prepared, aliased);
  await assert.rejects(prepareBuildContext({ ...f, prepared: aliased }), /must be a directory/);
  await assert.rejects(prepareBuildContext({ ...f, manifest: { ...f.manifest, sourceInventorySha256: '0'.repeat(64) } }), /tree does not match/);
  assert.equal(existsSync(f.output), false);
});

test('only the pinned official images, platform and keys are accepted as build inputs', async () => {
  const f = await fixture();
  const cases = [{ rustImage: 'docker.io/library/rust:1.98.1-bookworm' }, { rustImage: 'rust:1.98.1-bookworm@sha256:' + digest('a') },
    { rustImage: `docker.io/library/rust:latest@sha256:${digest('a')}` }, { nodeImage: `docker.io/library/node:26.2.0-bookworm-slim@sha256:${digest('A')}` },
    { nodeImage: `ghcr.io/private/node:26.2.0-bookworm-slim@sha256:${digest('b')}` }, { nodeImage: [inputs.nodeImage] },
    { platform: 'linux/amd64' }, { schema: '1' }, { command: 'cargo build' }, { rustImage: undefined }];
  for (const change of cases) await assert.rejects(prepareBuildContext({ ...f, inputs: { ...inputs, ...change } }), /Build input/);
  await assert.rejects(prepareBuildContext({ ...f, inputs: [] }), /Build inputs/);
  assert.equal(existsSync(f.output), false);
});

test('existing, nested and symlinked outputs are refused', async () => {
  const f = await fixture();
  await mkdir(f.output); await writeFile(join(f.output, 'keep'), 'mine');
  await assert.rejects(prepareBuildContext(f), /EEXIST/);
  assert.deepEqual(await readdir(f.output), ['keep']);
  await symlink(join(f.base, 'elsewhere'), join(f.base, 'linked'));
  await assert.rejects(prepareBuildContext({ ...f, output: join(f.base, 'linked') }), /EEXIST/);
  await symlink(f.root, join(f.base, 'alias'));
  for (const output of [f.root, join(f.root, 'out'), join(f.prepared, 'out'), join(f.prepared, 'source/out'), join(f.base, 'alias/out')]) {
    await assert.rejects(prepareBuildContext({ ...f, output }), /Output must be outside input/);
  }
  assert.equal(existsSync(join(f.root, 'out')), false);
});

test('symlinked production inputs are refused before output', async () => {
  const cases = [
    async root => { await rm(join(root, 'package.json')); await symlink(join(root, 'notes.txt'), join(root, 'package.json')); },
    async root => { await rm(join(root, 'patches'), { recursive: true }); await symlink(join(root, 'docker'), join(root, 'patches')); },
    async root => symlink(join(root, 'notes.txt'), join(root, 'packages/runtime/src/link.mjs')),
    async root => { await rm(join(root, 'docker/runtime-source.Dockerfile')); await symlink(join(root, 'notes.txt'), join(root, 'docker/runtime-source.Dockerfile')); },
  ];
  for (const mutate of cases) {
    const f = await fixture();
    await mutate(f.root);
    await assert.rejects(prepareBuildContext(f), /ELOOP|ordinary|regular file/);
    assert.equal(existsSync(f.output), false);
  }
});

test('FIFO source receipts and production inputs refuse without waiting for a writer', async () => {
  for (const [location, path] of [['prepared', 'receipt.json'], ['root', 'docker/celld-supervisor.sh']]) {
    const f = await fixture();
    const input = join(f[location], path);
    await rm(input); execFileSync('mkfifo', [input]);
    const script = `import {prepareBuildContext} from ${JSON.stringify(new URL('./runtime-build-context.mjs', import.meta.url).href)}; await prepareBuildContext(JSON.parse(process.argv[1]));`;
    assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f)], { env, stdio: 'pipe', timeout: 10000 }), /regular file/);
    assert.equal(existsSync(f.output), false);
  }
});

test('the public CLI refuses a FIFO build-input file without waiting for a writer', async () => {
  const f = await fixture();
  const input = join(f.base, 'inputs.json');
  execFileSync('mkfifo', [input]);
  assert.throws(() => execFileSync(process.execPath, ['scripts/runtime-build-context.mjs', f.prepared, input, f.output], { env, stdio: 'pipe', timeout: 10000 }), /bounded regular file/);
  assert.equal(existsSync(f.output), false);
});

test('templates with unresolved tokens or undeclared bases, and extra patched dependencies, are refused', async () => {
  const cases = [['docker/runtime-source.Dockerfile', template.replace('@@NODE_IMAGE@@', 'node:26')], ['docker/runtime-source.Dockerfile', `${template}LABEL x=@@SEED_IMAGE@@\n`],
    ['docker/runtime-source.Dockerfile', `FROM ghcr.io/private/seed@sha256:${digest('c')} AS seed\n${template}`],
    ['docker/runtime-source.Dockerfile', `${template}COPY --from=ghcr.io/private/seed:1 /x /x\n`],
    ['pnpm-workspace.yaml', `${production['pnpm-workspace.yaml'][0]}  other@1.0.0: patches/other.patch\n`], ['package.json', '{"pnpm":{"patchedDependencies":{"a":"b"}}}']];
  for (const [path, text] of cases) {
    const f = await fixture();
    await writeFile(join(f.root, path), text);
    await assert.rejects(prepareBuildContext(f), /Dockerfile|patched dependency/);
    assert.equal(existsSync(f.output), false);
  }
});

test('native input declarations must match the prepared Cargo lock before output exists', async () => {
  for (const change of [{ v8CrateSha256: digest('a') }, { v8Version: '152.1.1' }]) {
    const f = await fixture();
    await writeFile(join(f.root, 'docker/runtime-native-inputs.json'), JSON.stringify({ ...nativeInputs, ...change }));
    await assert.rejects(prepareBuildContext(f), /checksum does not match|archive.url is invalid/);
    assert.equal(existsSync(f.output), false);
  }
});

test('a context that fails after writing is retained without a receipt', async () => {
  const f = await fixture();
  await put(f.root, { 'packages/runtime/src/.git/config': ['x', '644'] });
  await assert.rejects(prepareBuildContext(f), /unsafe entry/);
  assert.deepEqual((await readdir(f.output)).sort(), ['context', 'failure.json']);
  assert.equal(JSON.parse(await readFile(join(f.output, 'failure.json'), 'utf8')).complete, false);
});

test('the public CLI checks the pinned manifest and refuses forged synthetic receipts', async () => {
  const f = await fixture();
  const inputsFile = join(f.base, 'inputs.json');
  await writeFile(inputsFile, JSON.stringify(inputs));
  assert.throws(() => execFileSync(process.execPath, ['scripts/runtime-build-context.mjs', f.prepared, inputsFile, f.output], { cwd: join(import.meta.dirname, '..'), env, stdio: 'pipe' }), /does not match the pinned manifest/);
  assert.equal(existsSync(f.output), false);
});

const pinnedReady = existsSync('.upstream/celld/.git') && existsSync('docker/runtime-source.Dockerfile');
test('the pinned local chain assembles a context without builds or downloads', { skip: !pinnedReady && 'no local celld objects or runtime source template' }, async () => {
  const manifest = JSON.parse(await readFile('docker/runtime-source.json', 'utf8'));
  const base = await mkdtemp(join(tmpdir(), 'runtime-build-context-pinned-'));
  await prepareRuntimeSource({ repository: '.upstream/celld', output: join(base, 'prepared'), manifest });
  const receipt = await prepareBuildContext({ prepared: join(base, 'prepared'), inputs, output: join(base, 'out'), manifest });
  assert.equal(receipt.native.sourceInventorySha256, manifest.sourceInventorySha256);
  assert.equal((await lstat(join(base, 'out/context/docker/celld-supervisor.sh'))).mode & 0o777, 0o755);
  assert.ok(!existsSync(join(base, 'out/context/packages/runtime/test')) && !existsSync(join(base, 'out/context/packages/cli')));
  const dockerfile = await readFile(join(base, 'out/context/Dockerfile'), 'utf8');
  assert.deepEqual([...dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gm)].map(match => match[1]), [inputs.nodeImage, inputs.rustImage, inputs.nodeImage]);
  for (const [, sources] of dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gm)) for (const source of sources.split(' ')) assert.ok(existsSync(join(base, 'out/context', source)), source);
});

// The complete source-build workflow uses real child processes and private files;
// only the external Docker executable is substituted. Nothing compiles or downloads.
async function sourceBuildFixture(t, mode = 'success') {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const workerdVersion = '1.20261016.1', image = 'sha256:' + digest('a');
  await writeFile(join(f.root, 'packages/runtime/package.json'), JSON.stringify({ name: '@fogd/runtime', dependencies: { workerd: workerdVersion } }));
  await writeFile(join(f.root, 'docker/runtime-source.json'), JSON.stringify(f.manifest));
  await writeFile(join(f.root, 'docker/runtime-build-inputs.json'), JSON.stringify(inputs));
  const sourceFiles = {};
  for (const path of Object.keys(production).filter(path => path.startsWith('packages/'))) sourceFiles[path] = sha256(await readFile(join(f.root, path)));
  const nativeReceipt = { schema: 1, kind: 'verified-native-inputs', target: nativeInputs.target, v8Version: nativeInputs.v8Version, v8CrateSha256: nativeInputs.v8CrateSha256,
    assets: { archive: { file: 'rusty-v8.a.gz', sha256: digest('d'), bytes: 3 }, bindings: { file: 'rusty-v8-bindings.rs', sha256: digest('f'), bytes: 4 } }, compiled: false, qualified: false };
  const observed = { sourceFiles, celld: { sha256: digest('c'), bytes: 64 }, supervisor: { sha256: sha256(production['docker/celld-supervisor.sh'][0]), bytes: production['docker/celld-supervisor.sh'][0].length },
    workerd: { sha256: digest('d'), bytes: 64 }, nativeInputs: nativeReceipt,
    workerdInput: { schema: 1, package: 'workerd', version: workerdVersion, platformPackage: '@cloudflare/workerd-linux-arm64', sha256: digest('d'), bytes: 64, directNative: true, downloaded: false, executed: false },
    toolchain: 'rustc 1.98.1 (synthetic)\nhost: aarch64-unknown-linux-gnu\ncargo 1.98.1 (synthetic)\n' };
  if (mode === 'bad-output') observed.nativeInputs.qualified = true;
  const trace = join(f.base, 'docker-calls.jsonl'), fake = join(f.base, 'docker.mjs');
  await writeFile(fake, `import{appendFileSync,writeFileSync}from'node:fs';
const raw=process.argv.slice(2), mode=${JSON.stringify(mode)}, observed=${JSON.stringify(observed)}, image=${JSON.stringify(image)};
appendFileSync(${JSON.stringify(trace)},JSON.stringify(raw)+'\\n');
let args=raw;
if(args[0]==='--context'){if(args[1]!=='desktop-linux')process.exit(91);args=args.slice(2)}else if(args.join(' ')!=='context show')process.exit(92);
if(args[0]==='context')console.log('desktop-linux');
else if(args[0]==='info')console.log(JSON.stringify({OSType:'linux',Architecture:mode==='wrong-host'?'amd64':'aarch64'}));
else if(args[0]==='buildx')console.log('Driver: '+(mode==='wrong-driver'?'docker-container':'docker'));
else if(args[0]==='build'){
 console.log('private build stdout');console.error('private build stderr');
 if(mode==='failed-build')process.exit(17);
 writeFileSync(args[args.indexOf('--iidfile')+1],mode==='bad-image'?'fogd:mutable':image+'\\n');
 if(mode==='changed-context')writeFileSync(args.at(-1)+'/Dockerfile','changed');
}else if(args[0]==='image')console.log(JSON.stringify([{Id:image,Os:'linux',Architecture:'arm64',Config:{WorkingDir:'/app',Env:['PATH=/app/packages/runtime/node_modules/workerd/bin:/usr/local/bin:/usr/bin:/bin','NODE_VERSION=26.2.0']}}]));
else if(args[0]==='run')console.log(JSON.stringify(args.at(-1).includes('const result = await (')?observed:{binarySha256:observed.celld.sha256,supervisorSha256:observed.supervisor.sha256}));
else process.exit(93);
`);
  const run = (args, options) => execute(process.execPath, [fake, ...args], options);
  const capture = (command, args, options) => { assert.equal(command, 'docker'); return captureProcess(process.execPath, [fake, ...args], options); };
  return { ...f, image, observed, trace, invoke: () => buildSourceRuntime({ repository: join(f.base, 'celld'), root: f.root, output: f.output }, { run, capture }) };
}

test('source build retains bounded private logs and checked outputs without granting runtime admission', async t => {
  const f = await sourceBuildFixture(t), result = await f.invoke();
  assert.equal(result.image, f.image); assert.deepEqual(result.outputs, f.observed);
  assert.equal(result.buildCompleted, true); assert.equal(result.qualified, false); assert.equal(result.cleanHostVerified, false); assert.equal(result.applicationContainersStarted, false);
  assert.deepEqual(JSON.parse(await readFile(join(f.output, 'result.json'), 'utf8')), result);
  assert.equal(result.contextInventorySha256, JSON.parse(await readFile(join(f.output, 'build-inputs/receipt.json'), 'utf8')).contextInventorySha256);
  for (const name of ['build.stdout', 'build.stderr']) assert.equal((await lstat(join(f.output, name))).mode & 0o777, 0o600);
  assert.equal((await lstat(f.output)).mode & 0o777, 0o700);
  assert.match(await readFile(join(f.output, 'build.stderr'), 'utf8'), /private build stderr/);
  const calls = (await readFile(f.trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls[0], ['context', 'show']);
  assert.ok(calls.slice(1).every(args => args[0] === '--context' && args[1] === 'desktop-linux'));
  const builds = calls.filter(args => args[2] === 'build'); assert.equal(builds.length, 1);
  assert.ok(builds[0].includes('--no-cache') && builds[0].includes('--pull'));
  assert.equal(builds[0][builds[0].indexOf('--platform') + 1], 'linux/arm64');
  const inspections = calls.filter(args => args[2] === 'run'); assert.equal(inspections.length, 2);
  assert.ok(inspections.every(args => args.includes('--read-only') && args.includes('--entrypoint') && !args.includes('--mount')));
  assert.ok(!calls.some(args => args.includes('push') || args.includes('tag') || args.includes('compose')));
});

for (const [mode, error] of [
  ['failed-build', /did not complete/], ['bad-image', /immutable image identity/], ['bad-output', /dependency receipts differ/],
  ['changed-context', /context changed/], ['wrong-host', /Linux arm64 Docker host/], ['wrong-driver', /Docker driver/],
]) test(`source build withholds its completion record after ${mode}`, async t => {
  const f = await sourceBuildFixture(t, mode); await assert.rejects(f.invoke(), error);
  assert.equal(existsSync(join(f.output, 'result.json')), false);
  assert.equal(JSON.parse(await readFile(join(f.output, 'failure.json'), 'utf8')).complete, false);
  if (mode.startsWith('wrong-')) assert.equal(existsSync(join(f.output, 'build.stdout')), false);
  if (mode === 'failed-build') {
    assert.equal(JSON.parse(await readFile(join(f.output, 'build-attempt.json'), 'utf8')).exitCode, 17);
    assert.match(await readFile(join(f.output, 'build.stderr'), 'utf8'), /private build stderr/);
  }
});

test('source build refuses an existing output before contacting Docker or replacing user files', async t => {
  const f = await sourceBuildFixture(t); await mkdir(f.output); await writeFile(join(f.output, 'keep'), 'keep');
  await assert.rejects(f.invoke(), { code: 'EEXIST' });
  assert.equal(existsSync(f.trace), false); assert.deepEqual(await readdir(f.output), ['keep']);
});
