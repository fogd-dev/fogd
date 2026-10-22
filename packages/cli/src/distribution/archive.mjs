import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execute } from '../recovery/execute.mjs';
import { imageArchiveReader, parseImageMetadata } from '../recovery/image-metadata.mjs';

const safeMember = value => typeof value === 'string' && /^[a-zA-Z0-9_./-]+$/.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');
export async function verifyTransferArchive(file, entry) {
  const read = imageArchiveReader(file);
  const records = parseImageMetadata(await read('manifest.json'));
  if (!Array.isArray(records) || records.length !== 2) throw new Error('Transfer archive must contain exactly the qualified runtime and storage images');
  const expected = [entry.image, entry.storageImage].map(id => id.slice(7)).sort(), actual = [];
  for (const image of records) {
    assertImageRecord(image, expected);
    const config = await read(image.Config), hash = createHash('sha256').update(config).digest('hex');
    const metadata = parseImageMetadata(config);
    if (!expected.includes(hash) || metadata.os !== entry.os || metadata.architecture !== entry.architecture) throw new Error('Transfer archive image identity or architecture differs');
    actual.push(hash);
  }
  if (!isDeepStrictEqual(actual.sort(), expected)) throw new Error('Transfer image inventory differs');
  const names = (await execute('tar', ['-tf', file])).trim().split('\n');
  if (new Set(names).size !== names.length || names.some(path => !safeMember(path.replace(/\/$/, '')))) throw new Error('Transfer archive has duplicate or unsafe paths');
  if (names.includes('index.json')) await verifyTransferIndex(read, expected);
}

function assertImageRecord(image, expected) {
  if (!image || !safeMember(image.Config) || !expected.some(hash => [`${hash}.json`, `blobs/sha256/${hash}`].includes(image.Config)) || (image.RepoTags != null && (!Array.isArray(image.RepoTags) || image.RepoTags.length)) ||
    !Array.isArray(image.Layers) || !image.Layers.length || image.Layers.length > 512 || image.Layers.some(path => !safeMember(path))) throw new Error('Transfer image archive has tags or unsupported members');
}
async function verifyTransferIndex(read, expected) {
  const index = parseImageMetadata(await read('index.json'));
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests) || !index.manifests.length || index.manifests.length > 2) throw new Error('Unsupported transfer OCI index');
  for (const item of index.manifests) {
    if (!/^sha256:[a-f0-9]{64}$/.test(item.digest || '') || Object.keys(item.annotations || {}).length) throw new Error('Transfer OCI index has an unexpected digest or tag');
    const bytes = await read(`blobs/sha256/${item.digest.slice(7)}`), manifest = parseImageMetadata(bytes);
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== item.digest || !expected.includes(manifest.config?.digest?.slice(7))) throw new Error('Transfer OCI index differs from qualified image configuration');
  }
}
