export async function verifyStorage(conn, claims) {
  const classes = (await conn.json(['get', 'storageclasses'])).items;
  for (const claim of claims) {
    const name = claim.spec.storageClassName;
    const storage = classes.find(c => c.metadata.name === name);
    if (storage?.provisioner !== 'rancher.io/local-path' || storage.volumeBindingMode !== 'WaitForFirstConsumer') throw new Error('Recovery currently requires kind local-path storage with WaitForFirstConsumer');
    if (JSON.stringify(claim.spec.accessModes) !== '["ReadWriteOnce"]') throw new Error('Unsupported claim access mode');
  }
}
export async function verifyPlacement(conn, namespace, claim, node) {
  const pvc = await conn.json(['-n', namespace, 'get', 'pvc', claim]);
  const pv = await conn.json(['get', 'pv', pvc.spec.volumeName]);
  const terms = pv.spec.nodeAffinity?.required?.nodeSelectorTerms;
  const expressions = terms?.[0]?.matchExpressions;
  if (terms?.length !== 1 || !expressions?.some(e => e.key === 'kubernetes.io/hostname' && e.operator === 'In' && e.values.length === 1 && e.values[0] === node)) throw new Error('Claim node affinity differs from the required placement');
}
