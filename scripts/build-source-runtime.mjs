import { constants } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { docker } from '../packages/cli/src/recovery/docker.mjs';
import { writeJson } from '../packages/cli/src/recovery/bundle.mjs';
import { captureProcess } from '../packages/cli/src/logs/capture.mjs';
import { verifyRuntimeHost } from '../packages/cli/src/runtime/catalog.mjs';
import { verifyCronRuntimeImage } from '../packages/cli/src/runtime/cron-image.mjs';
import { validateNativeInputs } from '../docker/runtime-native-inputs.mjs';
import { prepareRuntimeSource, inventoryDigest, placeOutput, readRegularJson, sourceInventory } from './runtime-source.mjs';
import { prepareBuildContext } from './runtime-build-context.mjs';
import { inspectBuildOutputs } from './runtime-build-output.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_TIMEOUT = 60 * 60 * 1000, BUILD_LOG_BYTES = 64 * 1024 * 1024;

// Explicit maintainer operation: downloads dependencies and compiles a candidate.
// The command never enrolls an installation, tags/pushes an image or starts apps.
export async function buildSourceRuntime({ repository, output, root = repositoryRoot }, { run = docker, capture = captureProcess } = {}) {
  const target = await placeOutput(output, [root, repository]);
  await mkdir(target, { mode: 0o700 });
  try { return await build(target, repository, root, run, capture); }
  catch (error) {
    await writeJson(join(target, 'failure.json'), { complete: false, qualified: false, error: error.message });
    throw error;
  }
}

async function build(target, repository, root, run, capture) {
  const manifest = await readRegularJson(join(root, 'docker/runtime-source.json'));
  const inputs = await readRegularJson(join(root, 'docker/runtime-build-inputs.json'));
  const prepared = join(target, 'native-source'), contextOutput = join(target, 'build-inputs');
  await prepareRuntimeSource({ repository, output: prepared, manifest, patchRoot: root });
  const context = await prepareBuildContext({ prepared, inputs, output: contextOutput, manifest, root });
  const directory = join(contextOutput, 'context');
  const builder = (await run(['context', 'show'], { timeoutMs: 15000 })).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(builder)) throw new Error('Source builds require a named Docker context');
  const selected = (args, options) => run(['--context', builder, ...args], options);
  await verifyRuntimeHost(selected);
  const driver = await selected(['buildx', 'inspect', builder], { timeoutMs: 15000 });
  if (!/^Driver:\s+docker\s*$/m.test(driver)) throw new Error('Source builds require the selected context Docker driver');
  await unchanged(directory, context);
  const attempt = await capture('docker', ['--context', builder, 'build', '--builder', builder, '--platform', 'linux/arm64', '--no-cache', '--pull',
    '--iidfile', join(target, 'image-id'), directory], { stdout: join(target, 'build.stdout'), stderr: join(target, 'build.stderr'),
    timeoutMs: BUILD_TIMEOUT, maxBytes: BUILD_LOG_BYTES, graceMs: 1000 });
  await writeJson(join(target, 'build-attempt.json'), attempt);
  if (attempt.status !== 'captured' || attempt.exitCode !== 0) throw new Error('Source build did not complete; inspect private logs and the selected builder before retrying');
  const image = await imageId(join(target, 'image-id'));
  await unchanged(directory, context);
  const expected = { sourceFiles: context.programFiles, supervisorSha256: context.rootFiles['docker/celld-supervisor.sh'],
    nativeInputs: validateNativeInputs(await readRegularJson(join(directory, 'docker/runtime-native-inputs.json'))),
    workerdVersion: (await readRegularJson(join(directory, 'packages/runtime/package.json'))).dependencies.workerd };
  const observed = await inspectBuildOutputs(image, expected, selected);
  await verifyCronRuntimeImage({ image, os: 'linux', architecture: 'arm64', binarySha256: observed.celld.sha256, supervisorSha256: observed.supervisor.sha256 }, selected);
  await unchanged(directory, context);
  const result = { schema: 1, kind: 'runtime-source-build', complete: true, image, platform: 'linux/arm64', builder, driver: 'docker',
    contextInventorySha256: context.contextInventorySha256, native: context.native, baseImages: { rust: context.rustImage, node: context.nodeImage },
    outputs: observed, noCache: true, buildCompleted: true, cleanHostVerified: false, qualified: false, applicationContainersStarted: false };
  await writeJson(join(target, 'result.pending.json'), result);
  await rename(join(target, 'result.pending.json'), join(target, 'result.json'));
  return result;
}

async function unchanged(directory, context) {
  if (inventoryDigest(await sourceInventory(directory)) !== context.contextInventorySha256) throw new Error('Prepared build context changed; build outcome is withheld');
}

async function imageId(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat(), buffer = Buffer.alloc(81);
    if (!stat.isFile() || stat.size > 80) throw new Error('Build did not produce a bounded image identity');
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0), value = buffer.toString('utf8', 0, bytesRead).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('Build did not produce an immutable image identity');
    return value;
  } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/build-source-runtime.mjs LOCAL_CELLD_REPOSITORY NEW_OUTPUT_DIRECTORY');
  const result = await buildSourceRuntime({ repository: resolve(process.argv[2]), output: process.argv[3] });
  console.log(`Built candidate ${result.image}. Clean-host evidence and runtime qualification remain open.`);
}
