import { isDeepStrictEqual } from 'node:util';

export function snapshotEvidence(state, names, expected, protocol, now = Date.now()) {
  if (!isDeepStrictEqual(names, Object.keys(expected).sort())) throw new Error(`${protocol.name} inventory changed during backup`);
  if (!names.length) return null;
  const apps = {};
  for (const name of names) {
    const receipt = state.apps[name][protocol.field];
    if (!receipt || receipt.id !== expected[name]) throw new Error(`${protocol.name} snapshot preparation changed during shutdown`);
    protocol.match(state, name, receipt); protocol.check?.(receipt, now);
    apps[name] = receipt;
  }
  return { schema: 1, apps };
}

export function validateSnapshotEvidence(state, evidence, names, protocol, now = Date.now()) {
  if (!names.length) {
    if (evidence) throw new Error(`Unexpected ${protocol.name.toLowerCase()} recovery evidence`);
    return;
  }
  if (!evidence || evidence.schema !== 1 || !evidence.apps || typeof evidence.apps !== 'object' || Array.isArray(evidence.apps)) throw new Error(`${protocol.name} installation recovery requires a qualified snapshot; legacy ${protocol.legacy} bundles are unsupported`);
  const expected = Object.fromEntries(Object.entries(evidence.apps).map(([name, receipt]) => [name, receipt?.id]));
  if (!isDeepStrictEqual(snapshotEvidence(state, names, expected, protocol, now), evidence)) throw new Error(`${protocol.name} snapshot evidence differs from archived controller metadata`);
}

export function assertPinnedSnapshotImages(names, images, replicas) {
  if (names.length && (!images.controller || replicas.some(name => images[name] !== images.controller))) throw new Error('Background backup and restore require identical pinned controller and replica runtime images');
}
