export function policy() {
  return { schema: 2, family: 'celld-cron-r1', admission: 'candidate', image: 'sha256:'+'a'.repeat(64), storageImage: 'sha256:'+'b'.repeat(64),
    binarySha256: 'c'.repeat(64), supervisorSha256: 'd'.repeat(64), controllerArgs: ['packages/platform/src/main.mjs'],
    bucket: 'fogd', storage: { endpoint: 'http://minio:9000', region: 'us-east-1' }, fleets: [
      { id: 'slot-1', prefix: 'slots/slot-1', nodes: [{ host: 'slot-1-a', id: 'slot-1-a' }, { host: 'slot-1-b', id: 'slot-1-b' }] },
      { id: 'slot-2', prefix: 'slots/slot-2', nodes: [{ host: 'slot-2-a', id: 'slot-2-a' }, { host: 'slot-2-b', id: 'slot-2-b' }] },
    ] };
}
export function environment() {
  return { FOGD_BUCKET: 'fogd', S3_ENDPOINT: 'http://minio:9000', AWS_REGION: 'us-east-1', FOGD_SLOTS: JSON.stringify([
    { id: 'slot-1', prefix: 'slots/slot-1', nodes: ['slot-1-a', 'slot-1-b'] },
    { id: 'slot-2', prefix: 'slots/slot-2', nodes: ['slot-2-a', 'slot-2-b'] },
  ]) };
}
