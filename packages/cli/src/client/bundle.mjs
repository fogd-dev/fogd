import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientFormat, clientModules, verifyClientFiles, transferFingerprint } from '../distribution/bootstrap.mjs';
import { copyTransferFile } from '../distribution/files.mjs';
import { ignoreInputs, programInventory, copyProgram, assertProgramUnchanged } from '../distribution/program.mjs';
import { publicProgramPath } from '../distribution/manifest.mjs';

// This is the complete developer command graph. Operator commands, runtime
// executables, installation files and local state never enter the bundle.
const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const launcher = "import './program/packages/cli/src/client/main.mjs';\n";

export async function exportClientBundle(destination) {
  const path = resolve(destination), output = join(await realpath(dirname(path)), basename(path));
  const inputs = await clientInputs(sourceRoot), files = await programInventory(inputs);
  // mkdir is deliberately exclusive: never overwrite a previous or partial bundle.
  await mkdir(output, { mode: 0o700 });
  await copyProgram(inputs, join(output, 'program'), files);
  await copyTransferFile(fileURLToPath(new URL('../distribution/bootstrap.mjs', import.meta.url)), join(output, 'verify-client.mjs'));
  await writeFile(join(output, 'fogd.mjs'), launcher, { flag: 'wx', mode: 0o600 });
  await assertProgramUnchanged(inputs, files);
  for (const name of ['fogd.mjs', 'verify-client.mjs']) files[name] = await transferFingerprint(join(output, name));
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ format: clientFormat, files }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const manifestSha256 = (await transferFingerprint(join(output, 'manifest.json'))).sha256;
  await verifyClientFiles(output, manifestSha256);
  return { directory: output, manifestSha256, bootstrapSha256: files['verify-client.mjs'].sha256, files: Object.keys(files).length, bytes: Object.values(files).reduce((sum, item) => sum + item.bytes, 0), dockerContacted: false };
}

async function clientInputs(root) {
  const inputs = await ignoreInputs(root);
  for (const [name, files] of Object.entries(clientModules)) {
    const base = name === 'cli' ? 'packages/cli' : `node_modules/@fogd/${name}`;
    inputs.set(`${base}/package.json`, join(root, `packages/${name}/package.json`));
    for (const path of files) inputs.set(`${base}/src/${path}.mjs`, join(root, `packages/${name}/src/${path}.mjs`));
  }
  if ([...inputs.keys()].some(path => !publicProgramPath(path))) throw new Error('Unexpected file in public developer client inputs');
  return inputs;
}
