import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFamily } from '../runtime/catalog.mjs';
import { exportRuntimeBundle, publicBundleDestination } from '../distribution/bundle.mjs';
import { exportClientBundle } from '../client/bundle.mjs';
import { releaseFormat, validateReleaseVersion, verifyReleaseFiles, transferFingerprint } from '../distribution/bootstrap.mjs';
import { transferFiles, copyTransferFile } from '../distribution/files.mjs';

export async function exportReleaseBundle(destination, version, family) {
  validateReleaseVersion(version);
  const entry = runtimeFamily(family), output = await publicBundleDestination(destination);
  await mkdir(output, { mode: 0o700 });
  const operator = await exportRuntimeBundle(join(output, 'operator'), entry.id);
  const client = await exportClientBundle(join(output, 'client'));
  await copyTransferFile(fileURLToPath(new URL('../distribution/bootstrap.mjs', import.meta.url)), join(output, 'verify-release.mjs'));
  const files = {};
  for (const path of await transferFiles(output)) files[path] = await transferFingerprint(join(output, path));
  const manifest = { format: releaseFormat, version, runtime: entry.id, runtimeManifestSha256: operator.manifestSha256, clientManifestSha256: client.manifestSha256, files };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const manifestSha256 = (await transferFingerprint(join(output, 'manifest.json'))).sha256;
  await verifyReleaseFiles(output, manifestSha256);
  return { directory: output, version, runtime: entry.id, manifestSha256, bootstrapSha256: files['verify-release.mjs'].sha256,
    runtimeManifestSha256: operator.manifestSha256, clientManifestSha256: client.manifestSha256, files: Object.keys(files).length,
    bytes: Object.values(files).reduce((total, file) => total + file.bytes, 0), servicesStarted: false };
}
