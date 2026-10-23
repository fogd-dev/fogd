import { join } from 'node:path';
import { inspectRetainedArtifact } from './artifact-inventory.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex64 = /^[0-9a-f]{64}$/;
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid() {
  const error = new Error('Controller artifact pins are malformed; restore a consistent state.json');
  error.code = 'ARTIFACT_PINS_INVALID';
  return error;
}

function pinnedRelease(deployments, id, digest) {
  const record = Object.hasOwn(deployments, id) ? deployments[id] : null;
  return uuid.test(id) && typeof digest === 'string' && hex64.test(digest) && isMap(record) && record.id === id && record.digest === digest;
}

// Advisory retention metadata: { schema: 1, releases: { [deployment id]: artifact digest } }.
export function validateArtifactPins(state) {
  if (!isMap(state)) throw invalid();
  if (!Object.hasOwn(state, 'artifactPins')) return {};
  const pins = state.artifactPins;
  if (!isMap(pins) || Object.keys(pins).sort().join() !== 'releases,schema' || pins.schema !== 1 || !isMap(pins.releases) || !isMap(state.deployments)) throw invalid();
  for (const [id, digest] of Object.entries(pins.releases)) if (!pinnedRelease(state.deployments, id, digest)) throw invalid();
  return pins.releases;
}

async function assertStoredArtifact(controller, id, digest) {
  const row = await inspectRetainedArtifact(join(controller.dir, 'artifacts'), id);
  if (row.digest !== digest) throw new Error('Stored artifact digest mismatch');
}

// Retention intent only: never deletes files. Metadata changes only after the artifact is verified,
// and a failed save leaves the controller latched for a reload rather than guessing a rollback.
export function setArtifactPin(controller, id, digest, kept) {
  return controller.exclusive(async () => {
    if (typeof id !== 'string' || !uuid.test(id) || typeof digest !== 'string' || !hex64.test(digest) || typeof kept !== 'boolean') throw new Error('Artifact pin requires a deployment id, artifact digest and boolean kept');
    const releases = validateArtifactPins(controller.state);
    if (!pinnedRelease(controller.state.deployments, id, digest)) throw new Error('Deployment/digest mismatch');
    if (kept && Object.hasOwn(controller.state.deployments[id], 'artifactPruned')) throw new Error('Pruned artifact history cannot be pinned; inspect the current retention plan');
    const result = { schema: 1, id, digest, kept };
    if (kept) await assertStoredArtifact(controller, id, digest);
    if (kept === Object.hasOwn(releases, id)) return result;
    const next = Object.entries(releases).filter(([pinned]) => pinned !== id);
    if (kept) next.push([id, digest]);
    controller.state.artifactPins = { schema: 1, releases: Object.fromEntries(next.sort(([a], [b]) => a < b ? -1 : 1)) };
    await controller.save();
    return result;
  });
}
