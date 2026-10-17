import { execute } from '../../recovery/execute.mjs';
export async function verifyImages(conn, images, expected) {
  const ids = {};
  for (const image of Object.values(images)) {
    const local = (await execute('docker', ['image', 'inspect', image, '--format', '{{.Id}}'])).trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(local) || (expected && expected[image] !== local)) throw new Error('Local image identity differs from snapshot');
    for (const node of conn.nodes) {
      const data = JSON.parse(await execute('docker', ['exec', node.metadata.name, 'crictl', 'inspecti', image]));
      if (data.status.id !== local) throw new Error('Node image identity differs from the required local image');
    }
    ids[image] = local;
  }
  return ids;
}

const sameTag = (a, b) => a === b || a === `docker.io/${b}` || a === `docker.io/library/${b}`;
async function runningConfig(node, status, expected) {
  const digest = /sha256:[a-f0-9]{64}$/.exec(status.imageID)?.[0];
  if (!digest) throw new Error('Unrecognized running image identity');
  if (digest === expected) return digest;
  const content = async value => JSON.parse(await execute('docker', ['exec', node, 'ctr', '-n', 'k8s.io', 'content', 'get', value]));
  let blob = await content(digest);
  if (blob.manifests) {
    const matches = blob.manifests.filter(m => sameTag(m.annotations?.['io.containerd.image.name'], status.image));
    if (matches.length !== 1) throw new Error('Ambiguous kind import image identity');
    blob = await content(matches[0].digest);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(blob.config?.digest || '')) throw new Error('Missing immutable image configuration identity');
  return blob.config.digest;
}
export async function verifyRunningImages(pods, tags, images) {
  for (const pod of pods) {
    for (const status of [...(pod.status.containerStatuses || []), ...(pod.status.initContainerStatuses || [])]) {
      const tag = status.name === 'minio' ? tags.minio : tags.runtime;
      if (!sameTag(status.image, tag) || await runningConfig(pod.spec.nodeName, status, images[tag]) !== images[tag]) throw new Error('A pod uses a different image identity');
    }
  }
}

export async function restoreImages(conn, bundle, archive) {
  let missing = false;
  for (const [image, id] of Object.entries(bundle.manifest.images)) {
    const existing = (await execute('docker', ['image', 'ls', '--no-trunc', '-q', image])).trim();
    if (existing && existing !== id) throw new Error('Refusing to overwrite a conflicting local image tag');
    missing ||= !existing;
  }
  let nodeMissing = false;
  for (const node of conn.nodes) {
    const stored = JSON.parse(await execute('docker', ['exec', node.metadata.name, 'crictl', 'images', '--output', 'json'])).images;
    for (const [tag, id] of Object.entries(bundle.manifest.images)) {
      const found = stored.find(image => image.repoTags?.some(t => sameTag(t, tag)));
      if (found && found.id !== id) throw new Error('Refusing to overwrite a conflicting node image tag');
      nodeMissing ||= !found;
    }
  }
  if (missing) await execute('docker', ['image', 'load', '-i', archive]);
  for (const [tag, id] of Object.entries(bundle.manifest.images)) {
    if ((await execute('docker', ['image', 'inspect', tag, '--format', '{{.Id}}'])).trim() !== id) throw new Error('Loaded archive does not provide the required image identity');
  }
  if (nodeMissing) await execute('kind', ['load', 'docker-image', '--name', conn.cluster, ...Object.keys(bundle.manifest.images)]);
  await verifyImages(conn, bundle.topology.images, bundle.manifest.images);
}
