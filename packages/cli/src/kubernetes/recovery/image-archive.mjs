import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execute } from '../../recovery/execute.mjs';
import { imageArchiveReader, parseImageMetadata as parse } from '../../recovery/image-metadata.mjs';

const sha = input => createHash('sha256').update(input).digest('hex');
const canonical = tag => !tag.includes('/') ? `docker.io/library/${tag}` : /[.:]|^localhost$/.test(tag.split('/')[0]) ? tag : `docker.io/${tag}`;
export function imageTags(manifest, expected) {
  if (Object.keys(expected).some(tag => !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(tag))) throw new Error('Invalid snapshot image reference');
  const tags = {};
  for (const image of manifest) {
    if (!Array.isArray(image.RepoTags) || !image.RepoTags.length) throw new Error('Unidentified image in archive');
    for (const tag of image.RepoTags) {
      const id = expected[tag]?.slice(7);
      if (!id || tags[tag] || ![`${id}.json`, `blobs/sha256/${id}`].includes(image.Config)) throw new Error('Image archive contains unexpected tags or configuration identities');
      tags[tag] = image.Config;
    }
  }
  if (!isDeepStrictEqual(Object.keys(tags).sort(), Object.keys(expected).sort())) throw new Error('Image archive is missing required tags');
  return tags;
}
export async function verifyImageArchive(archive, expected) {
  const read = imageArchiveReader(archive);
  const tags = imageTags(parse(await read('manifest.json')), expected);
  for (const [tag, path] of Object.entries(tags)) if (`sha256:${sha(await read(path))}` !== expected[tag]) throw new Error('Image configuration bytes differ from their recorded identity');
  const names = (await execute('tar', ['-tf', archive])).trim().split('\n');
  if (names.includes('index.json')) await verifyIndex(parse(await read('index.json')), expected, read);
}
async function verifyIndex(index, expected, read) {
  const seen = [];
  for (const item of index.manifests || []) {
    const tag = Object.keys(expected).find(t => canonical(t) === item.annotations?.['io.containerd.image.name']);
    if (!tag || seen.includes(tag) || item.annotations?.['org.opencontainers.image.ref.name'] !== tag.split(':').at(-1) || !/^sha256:[a-f0-9]{64}$/.test(item.digest)) throw new Error('OCI index contains unexpected image tags');
    const bytes = await read(`blobs/sha256/${item.digest.slice(7)}`);
    if (`sha256:${sha(bytes)}` !== item.digest || parse(bytes).config?.digest !== expected[tag]) throw new Error('OCI index image differs from the recorded configuration');
    seen.push(tag);
  }
  if (!isDeepStrictEqual(seen.sort(), Object.keys(expected).sort())) throw new Error('OCI index is missing required images');
}
