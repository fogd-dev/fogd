import { selectArchiveRecovery, verifyArchiveAuthority, inspectArchiveMigrations, inspectArchiveBackgrounds } from './app-archive-verification.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateRuntimePolicy } from './runtime-policy.mjs';
import { validateAppArchives } from './app-archive.mjs';
import { appArchiveRotationCapability } from './app-archive-rotation-state.mjs';
import { authenticatedDecision, decisionReviewToken } from './decision-history.mjs';
import { verifiedReviewArtifact } from './review-artifact.mjs';
import { backendRuntimeIdentity } from './backend-runtime-identity.mjs';

const refused = () => Object.assign(new Error('Archive secret rotation is unconfirmed; keep execution held and retain the current vault and all recovery records'), { code: 'APP_ARCHIVE_ROTATION_REFUSED' });
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const commitment = values => createHash('sha256').update(JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

function selected(controller, profile, input) {
  if (validateRuntimePolicy(profile).schema !== 4) throw refused();
  const item = selectArchiveRecovery(controller, profile, input), current = controller.secrets.index[item.record.name]?.revision;
  if (!item.release.requiredSecrets?.length || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(current || '') || input.secretRevision !== current ||
    input.secretRevision === item.release.secretRevision || item.app.archiveRecovery.rotation && item.app.archiveRecovery.rotation.secretRevision !== current) throw refused();
  return { ...item, journal: item.app.archiveRecovery.rotation };
}
export function archiveRotationReview(controller, profile, name) {
  const app = controller.state.apps[name], records = validateAppArchives(controller.state, profile), record = records[app?.archiveRecovery?.archive];
  const release = controller.state.deployments[record?.app.active];
  const input = { archive: record?.id, identity: record?.identity, snapshot: record?.restoration?.snapshot,
    deployment: release?.id, digest: release?.digest, secretRevision: controller.secrets.index[name]?.revision };
  selected(controller, profile, input);
  const review = createHash('sha256').update(JSON.stringify(['fogd-archive-secret-rotation-v1', decisionReviewToken(controller, release.id), input])).digest('hex');
  return { app: name, state: 'pending', execution: 'held', selection: input, review,
    notice: 'Approve the retained code with this current vault revision. Rotation publishes private configuration without applying SQL. HTTP and background recovery remain held.' };
}
export async function stageArchiveRotationSecrets(controller, profile, name, input) {
  return controller.exclusive(async () => {
    if (!exact(input, ['archive', 'identity', 'snapshot', 'deployment', 'digest', 'values']) || validateRuntimePolicy(profile).schema !== 4) throw refused();
    const record = validateAppArchives(controller.state, profile)[input.archive], app = controller.state.apps[name], release = controller.state.deployments[input.deployment];
    if (record?.status !== 'restored' || record.name !== name || record.identity !== input.identity || record.restoration.snapshot !== input.snapshot ||
      record.app.active !== input.deployment || record.digest !== input.digest || app.archiveRecovery.rotation || !release?.requiredSecrets?.length ||
      !release.requiredSecrets.every(key => typeof input.values?.[key] === 'string' && input.values[key])) throw refused();
    await controller.routes.checkReady();
    return controller.secrets.replace(name, input.values);
  });
}
async function existingRuntime(controller, item, verifyIdentity) {
  if ((await controller.backend.owner(item.slot))?.app !== item.record.name) throw refused();
  await verifyIdentity(item.slot);
  let version = item.journal?.version;
  if (!item.journal) {
    await controller.routes.options.verifyRuntime(item.record.name, { id: item.release.id, digest: item.release.digest });
    version = item.release.version;
  } else if (!version) {
    const versions = await Promise.all(item.slot.nodes.map(async node => (await controller.backend.deployment(node))?.version));
    if (!versions.length || versions.some(v => typeof v !== 'string' || !v || v !== versions[0])) throw refused();
    version = versions[0];
  }
  await inspectArchiveBackgrounds(controller, item, version);
}
async function publish(controller, item, secrets) {
  const { app, release, slot } = item;
  if (!item.journal) {
    app.archiveRecovery.rotation = { secretRevision: secrets.revision, valuesSha256: commitment(secrets.values), version: null };
    controller.state.requirements = [...new Set([...controller.state.requirements, appArchiveRotationCapability])];
    item.journal = app.archiveRecovery.rotation;
    await controller.save();
  }
  if (!item.journal.version) {
    const execution = await controller.secrets.materialize(release, controller.artifact(release.id), secrets.values);
    const version = await controller.backend.publish(slot, execution);
    if (typeof version !== 'string' || !version || version.length > 512) throw refused();
    item.journal.version = version; await controller.save();
  }
  await controller.backend.ready(slot, item.journal.version);
  await controller.routes.options.verifyRuntime(item.record.name, { id: release.id, digest: release.digest },
    { version: item.journal.version, secretRevision: secrets.revision });
  await inspectArchiveBackgrounds(controller, item, item.journal.version);
}
function complete(controller, item, decision) {
  const { app, release, record, journal } = item;
  release.version = journal.version; release.secretRevision = journal.secretRevision;
  for (const [field, recovery] of [['delivery', 'queueRecovery'], ['dispatch', 'cronRecovery']]) {
    if (!app[field]) continue;
    app[field].version = journal.version; app[field].observedAt = new Date(controller.clock()).toISOString();
    app[recovery].prepared.version = journal.version;
    if (field === 'dispatch') app[recovery].prepared.secretRevision = journal.secretRevision;
  }
  record.restoration.rotation = structuredClone(journal); record.restoration.decision = decision.id; record.status = 'recovered';
  delete app.archiveRecovery;
  return release;
}
async function rotate(controller, profile, input, beforeEffects, decision, verifyIdentity) {
  const item = selected(controller, profile, input), before = await verifyArchiveAuthority(controller, profile);
  await verifiedReviewArtifact(controller, item.release.id);
  const secrets = await controller.secrets.select({ ...item.release, secretRevision: input.secretRevision }, input.secretRevision);
  if (item.journal && item.journal.valuesSha256 !== commitment(secrets.values)) throw refused();
  beforeEffects(); await existingRuntime(controller, item, verifyIdentity); await inspectArchiveMigrations(controller, item);
  await publish(controller, item, secrets); await inspectArchiveMigrations(controller, item);
  await verifiedReviewArtifact(controller, item.release.id);
  const afterSecrets = await controller.secrets.select({ ...item.release, secretRevision: input.secretRevision }, input.secretRevision);
  if (before.digest !== (await verifyArchiveAuthority(controller, profile)).digest || !isDeepStrictEqual(secrets, afterSecrets) ||
    controller.secrets.index[item.record.name]?.revision !== secrets.revision || selected(controller, profile, input).journal !== item.journal) throw refused();
  return complete(controller, item, decision);
}
export function rotateAppArchiveRecovery(controller, profile, input, context, { verifyIdentity = slot => backendRuntimeIdentity(controller.backend, profile).verify(slot) } = {}) {
  return controller.exclusive(async () => {
    let cleanupId = null;
    try {
      const item = selected(controller, profile, input); cleanupId = item.release.id;
      const result = await authenticatedDecision(controller, input.deployment, input.digest, 'approve', input.secretRevision, context,
        (beforeEffects, decision) => rotate(controller, profile, input, beforeEffects, decision, verifyIdentity),
        async (_, id, decision) => {
          if (!/^[a-f0-9]{64}$/.test(decision.review || '') || decision.review !== archiveRotationReview(controller, profile, item.record.name).review) throw refused();
          await verifiedReviewArtifact(controller, id);
        });
      validateAppArchives(controller.state, profile);
      return { archive: input.archive, identity: input.identity, deployment: result.id, digest: result.digest, state: 'approved', execution: 'held' };
    } catch {
      controller.assertStorage(); throw refused();
    } finally {
      try { if (cleanupId) await controller.secrets.cleanup(cleanupId); } catch { controller.assertStorage(); throw refused(); }
    }
  });
}
