import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJson } from '../packages/cli/src/recovery/bundle.mjs';
import { programInventory } from '../packages/cli/src/runtime/program-inventory.mjs';
import { inventoryDigest, placeOutput, readRegularJson, sourceInventory, verifyPreparedSource } from './runtime-source.mjs';

// Source-only: assembles a complete build context from a re-verified prepared
// native tree and the checkout's production files. Nothing is built, pulled or
// qualified, and the declared base digests authorize no enrollment.
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const rootFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/void@1.1.11.patch', 'docker/runtime-tools/package.json', 'docker/runtime-tools/package-lock.json', 'docker/celld-supervisor.sh'];
const template = 'docker/runtime-source.Dockerfile';
const images = { rustImage: /^docker\.io\/library\/rust:1\.98\.1-bookworm@sha256:[0-9a-f]{64}$/, nodeImage: /^docker\.io\/library\/node:26\.2\.0-bookworm-slim@sha256:[0-9a-f]{64}$/ };

export async function prepareBuildContext({ prepared, inputs, output, manifest, root = repositoryRoot }) {
  validateInputs(inputs);
  if (!(await lstat(root)).isDirectory()) throw new Error('Repository root must be an ordinary directory');
  const captured = await capture(resolve(prepared), root, inputs, manifest);
  const target = await placeOutput(output, [root, resolve(prepared)]);
  await mkdir(target, { mode: 0o700 });
  try { return await assemble(target, captured, inputs, manifest); }
  catch (error) { await writeJson(join(target, 'failure.json'), { complete: false, error: error.message }); throw error; }
}

function validateInputs(inputs) {
  const keys = inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? Object.keys(inputs).sort().join() : '';
  if (keys !== 'nodeImage,platform,rustImage,schema' || inputs.schema !== 1 || inputs.platform !== 'linux/arm64') throw new Error('Build inputs need exactly schema 1, platform linux/arm64, rustImage and nodeImage');
  for (const [key, pattern] of Object.entries(images)) {
    if (typeof inputs[key] !== 'string' || !pattern.test(inputs[key])) throw new Error(`Build input ${key} must be the pinned official tag with a sha256 digest`);
  }
}

// Every byte is held in memory and checked against its verified hash before any output exists.
async function capture(prepared, root, inputs, manifest) {
  const { receipt, inventory } = await verifyPreparedSource(prepared, manifest);
  const files = new Map();
  for (const [path, expected] of inventory) {
    const file = await readOrdinary(join(prepared, 'source'), path);
    if (sha256(file.bytes) !== expected.sha256 || file.mode !== expected.mode) throw new Error(`Prepared source ${path} changed while it was captured`);
    files.set(`native/${path}`, file);
  }
  const program = await programInventory(root);
  for (const [path, hash] of Object.entries(program)) {
    const { bytes } = await readOrdinary(root, path);
    if (sha256(bytes) !== hash) throw new Error(`Runtime program ${path} changed while it was captured`);
    files.set(path, { bytes, mode: '644' });
  }
  for (const path of rootFiles) files.set(path, { bytes: (await readOrdinary(root, path)).bytes, mode: path.endsWith('.sh') ? '755' : '644' });
  checkPatchedDependencies(files);
  const templateBytes = (await readOrdinary(root, template)).bytes;
  files.set('Dockerfile', { bytes: Buffer.from(render(templateBytes.toString('utf8'), inputs)), mode: '644' });
  return { files, receipt, program, templateSha256: sha256(templateBytes) };
}

// Each traversed directory is lstat-checked and the file itself is opened without following links.
async function readOrdinary(base, path) {
  const parts = path.split('/');
  for (let depth = 0; depth < parts.length; depth++) {
    if (!(await lstat(join(base, ...parts.slice(0, depth)))).isDirectory()) throw new Error(`Build input ${path} must be under ordinary directories`);
  }
  const file = await open(join(base, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`Build input ${path} must be a regular file`);
    return { bytes: await file.readFile(), mode: info.mode & 0o111 ? '755' : '644' };
  } finally { await file.close(); }
}

function checkPatchedDependencies(files) {
  const block = /^patchedDependencies:\n((?:[ \t]+\S.*(?:\n|$))*)/m.exec(files.get('pnpm-workspace.yaml').bytes.toString('utf8'))?.[1].trim();
  if (block !== 'void@1.1.11: patches/void@1.1.11.patch' || JSON.parse(files.get('package.json').bytes).pnpm?.patchedDependencies) throw new Error('void@1.1.11 must be the sole pnpm patched dependency');
}

function render(text, inputs) {
  if (!text.includes('@@RUST_IMAGE@@') || !text.includes('@@NODE_IMAGE@@')) throw new Error('Runtime source Dockerfile must use @@RUST_IMAGE@@ and @@NODE_IMAGE@@');
  const rendered = text.replaceAll('@@RUST_IMAGE@@', inputs.rustImage).replaceAll('@@NODE_IMAGE@@', inputs.nodeImage);
  if (rendered.includes('@@')) throw new Error('Runtime source Dockerfile has an unresolved @@ token');
  checkBases(rendered, inputs);
  return rendered;
}

// Only the declared images or earlier stages may be a FROM or COPY --from source.
function checkBases(text, inputs) {
  const stages = new Set();
  for (const line of text.split('\n').map(item => item.trim())) {
    const words = line.split(/\s+/).filter(word => word !== '--platform=linux/arm64');
    if (/^from$/i.test(words[0])) {
      const named = words.length === 4 && /^as$/i.test(words[2]);
      if (!(named || words.length === 2) || (![inputs.rustImage, inputs.nodeImage].includes(words[1]) && !stages.has(words[1]))) throw new Error(`Runtime source Dockerfile has an undeclared base: ${line}`);
      if (named) stages.add(words[3]);
    }
    for (const [, from] of line.matchAll(/--from=(\S+)/g)) if (!stages.has(from)) throw new Error(`Runtime source Dockerfile copies from an undeclared stage: ${from}`);
  }
}

async function assemble(target, { files, receipt, program, templateSha256 }, inputs, manifest) {
  const context = join(target, 'context');
  for (const [path, { bytes, mode }] of files) {
    await mkdir(dirname(join(context, path)), { recursive: true });
    await writeFile(join(context, path), bytes, { flag: 'wx' });
    await chmod(join(context, path), mode === '755' ? 0o755 : 0o644);
  }
  await normalizeContext(context);
  if (inventoryDigest(await sourceInventory(join(context, 'native'))) !== manifest.sourceInventorySha256) throw new Error('Copied native tree does not match the pinned source');
  const expected = new Map([...files.keys()].sort().map(path => [path, { sha256: sha256(files.get(path).bytes), mode: files.get(path).mode }]));
  const actual = await sourceInventory(context), contextInventorySha256 = inventoryDigest(actual);
  if (contextInventorySha256 !== inventoryDigest(expected)) throw new Error('Written build context does not match the captured bytes');
  const { schema, complete, compiled, qualified, ...native } = receipt;
  const result = { schema: 1, complete: true, platform: inputs.platform, rustImage: inputs.rustImage, nodeImage: inputs.nodeImage, native, programFiles: program,
    rootFiles: Object.fromEntries(rootFiles.map(path => [path, expected.get(path).sha256])), templateSha256, dockerfileSha256: expected.get('Dockerfile').sha256,
    contextFiles: actual.size, contextInventorySha256, built: false, qualified: false };
  await writeJson(join(target, 'receipt.pending.json'), result);
  await rename(join(target, 'receipt.pending.json'), join(target, 'receipt.json'));
  return result;
}

async function normalizeContext(context) {
  const paths = [context, ...(await readdir(context, { recursive: true })).map(path => join(context, path))];
  for (const path of paths) {
    const info = await lstat(path);
    if (!info.isFile() && !info.isDirectory()) throw new Error('Build context entries must be ordinary files or directories');
    if (info.isDirectory()) await chmod(path, 0o755);
    await utimes(path, 0, 0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 5) throw new Error('Usage: node scripts/runtime-build-context.mjs PREPARED_NATIVE_DIRECTORY BUILD_INPUTS_JSON NEW_OUTPUT_DIRECTORY');
  const manifest = await readRegularJson(join(repositoryRoot, 'docker/runtime-source.json'));
  const inputs = await readRegularJson(resolve(process.argv[3]));
  const receipt = await prepareBuildContext({ prepared: process.argv[2], inputs, output: process.argv[4], manifest });
  console.log(`Prepared build context of ${receipt.contextFiles} files: ${receipt.contextInventorySha256}. Not built or qualified.`);
}
