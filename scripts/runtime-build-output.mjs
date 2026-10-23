import { isDeepStrictEqual } from 'node:util';
import { programInventory } from '../packages/cli/src/runtime/program-inventory.mjs';
import { runtimeInspector } from '../packages/cli/src/runtime/cron-image.mjs';

// Self-contained: the host supplies this reader to an isolated image inspector.
// It reads files only; neither the image entrypoint nor native programs execute.
export async function readBuildOutputs(root, bin, records, inventory) {
  const { constants } = await import('node:fs');
  const { open } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  async function text(path) {
    const file = await open(path, flags);
    try {
      const stat = await file.stat(), bytes = Buffer.alloc(65537);
      if (!stat.isFile() || stat.size > 65536) throw new Error('Build record must be a bounded regular file');
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) return bytes.toString('utf8', 0, length);
        length += bytesRead;
      }
      throw new Error('Build record exceeded its bound');
    } finally { await file.close(); }
  }
  async function fingerprint(path, native) {
    const file = await open(path, flags);
    try {
      const stat = await file.stat(), header = Buffer.alloc(20);
      if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error('Build output must be a regular executable');
      if (native) {
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (bytesRead !== 20 || !header.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) ||
          ![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== 183) throw new Error('Build output must be Linux arm64 ELF');
      }
      const hash = createHash('sha256'); let bytes = 0;
      for await (const part of file.createReadStream({ start: 0, autoClose: false })) { hash.update(part); bytes += part.length; }
      if (bytes !== stat.size) throw new Error('Build output changed during inspection');
      return { sha256: hash.digest('hex'), bytes };
    } finally { await file.close(); }
  }
  return { sourceFiles: await inventory(root, true),
    celld: await fingerprint(join(bin, 'celld'), true), supervisor: await fingerprint(join(bin, 'celld-supervisor'), false),
    workerd: await fingerprint(join(root, 'packages/runtime/node_modules/workerd/bin/workerd'), true),
    nativeInputs: JSON.parse(await text(join(records, 'native-inputs.json'))),
    workerdInput: JSON.parse(await text(join(records, 'workerd-input.json'))), toolchain: await text(join(records, 'native-toolchain.txt')) };
}

export async function inspectBuildOutputs(image, expected, run) {
  const code = `const result = await (${readBuildOutputs.toString()})('/app', '/usr/local/bin', '/usr/share/fogd-build', ${programInventory.toString()}); console.log(JSON.stringify(result));`;
  const observed = JSON.parse(await runtimeInspector(image, code, run));
  assertBuildOutputs(observed, expected);
  return observed;
}

export function assertBuildOutputs(observed, { sourceFiles, supervisorSha256, nativeInputs, workerdVersion }) {
  const fingerprint = value => value && Object.keys(value).sort().join() === 'bytes,sha256' && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0;
  if (!observed || !isDeepStrictEqual(Object.keys(observed).sort(), ['celld', 'nativeInputs', 'sourceFiles', 'supervisor', 'toolchain', 'workerd', 'workerdInput']) ||
    !isDeepStrictEqual(observed.sourceFiles, sourceFiles) || !['celld', 'supervisor', 'workerd'].every(key => fingerprint(observed[key])) ||
    observed.supervisor.sha256 !== supervisorSha256 || typeof observed.toolchain !== 'string' || !observed.toolchain.startsWith('rustc 1.98.1 ') ||
    !/^host: aarch64-unknown-linux-gnu$/m.test(observed.toolchain)) throw new Error('Built runtime outputs differ from the prepared inputs');
  const assets = Object.fromEntries([['archive', 'rusty-v8.a.gz'], ['bindings', 'rusty-v8-bindings.rs']].map(([key, file]) => [key, { file, sha256: nativeInputs[key].sha256, bytes: nativeInputs[key].bytes }]));
  const acquired = { schema: 1, kind: 'verified-native-inputs', target: nativeInputs.target, v8Version: nativeInputs.v8Version, v8CrateSha256: nativeInputs.v8CrateSha256, assets, compiled: false, qualified: false };
  const placed = { schema: 1, package: 'workerd', version: workerdVersion, platformPackage: '@cloudflare/workerd-linux-arm64', ...observed.workerd, directNative: true, downloaded: false, executed: false };
  if (!isDeepStrictEqual(observed.nativeInputs, acquired) || !isDeepStrictEqual(observed.workerdInput, placed)) throw new Error('Built dependency receipts differ from the prepared inputs');
}
