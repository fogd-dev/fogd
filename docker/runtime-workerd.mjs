import { constants, createReadStream } from 'node:fs';
import { lstat, readFile, realpath, copyFile, chmod, rename, mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertGatewayExecutable, gatewayExecutable } from '../packages/runtime/src/gateway-executable.mjs';

const platformPackage = '@cloudflare/workerd-linux-arm64';
const refused = () => new Error('Locked Linux arm64 workerd input is unavailable or inconsistent');
async function metadata(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 65536) throw refused();
    const buffer = Buffer.alloc(65537); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) return JSON.parse(buffer.subarray(0, length));
      length += bytesRead;
    }
    throw refused();
  } finally { await file.close(); }
}
async function fingerprint(path) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const part of createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) { hash.update(part); bytes += part.length; }
  return { sha256: hash.digest('hex'), bytes };
}

// Uses only the already-installed locked platform package. No installer script,
// network request, fallback package manager or native binary is executed here.
export async function prepareWorkerd(directory, version) {
  try {
    if (typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw refused();
    const root = await realpath(directory), pkg = await metadata(join(root, 'package.json'));
    if (pkg.name !== 'workerd' || pkg.version !== version || pkg.optionalDependencies?.[platformPackage] !== version) throw refused();
    const binary = createRequire(join(root, 'package.json')).resolve(`${platformPackage}/bin/workerd`);
    const platform = await metadata(join(dirname(dirname(binary)), 'package.json'));
    if (platform.name !== platformPackage || platform.version !== version || JSON.stringify(platform.os) !== '["linux"]' || JSON.stringify(platform.cpu) !== '["arm64"]') throw refused();
    await assertGatewayExecutable(binary);
    const target = join(root, 'bin/workerd'), info = await lstat(target);
    if (!info.isFile()) throw refused();
    const expected = await fingerprint(binary), pending = target + '.fogd-native.pending';
    await copyFile(binary, pending, constants.COPYFILE_EXCL); await chmod(pending, 0o755);
    await assertGatewayExecutable(pending);
    const copied = await fingerprint(pending);
    if (copied.sha256 !== expected.sha256 || copied.bytes !== expected.bytes) throw refused();
    await rename(pending, target); await assertGatewayExecutable(target);
    return { schema: 1, package: 'workerd', version, platformPackage, ...expected, directNative: true, downloaded: false, executed: false };
  } catch { throw refused(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('This recipe helper takes no command-line overrides');
  const runtime = JSON.parse(await readFile(new URL('../packages/runtime/package.json', import.meta.url), 'utf8'));
  const receipt = await prepareWorkerd(dirname(dirname(gatewayExecutable)), runtime.dependencies.workerd);
  await mkdir('/usr/share/fogd-build', { recursive: true });
  const file = await open('/usr/share/fogd-build/workerd-input.json', 'wx', 0o644);
  try { await file.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  console.log(JSON.stringify(receipt));
}
