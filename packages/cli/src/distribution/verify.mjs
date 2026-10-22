import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyTransferFiles, readTransferMetadata } from './bootstrap.mjs';
import { validateTransferManifest } from './manifest.mjs';
import { runtimeFamilies } from '../runtime/catalog.mjs';

export async function verifyTransferBundle(directory, entry, expectedManifest) {
  const manifest = validateTransferManifest(await verifyTransferFiles(directory, expectedManifest), entry);
  const catalog = await readTransferMetadata(join(directory, 'program/packages/cli/src/runtime/catalog.json'));
  if (!isDeepStrictEqual(catalog, runtimeFamilies())) throw new Error('Transferred CLI catalog differs from this trusted CLI');
  const metadata = await readTransferMetadata(join(directory, 'program/node_modules/ignore/package.json'));
  const runtime = await readTransferMetadata(join(directory, 'program/packages/runtime/package.json'));
  if (metadata.name !== 'ignore' || metadata.version !== runtime.dependencies.ignore || metadata.license !== 'MIT') throw new Error('Transferred operator dependency differs');
  return manifest;
}
