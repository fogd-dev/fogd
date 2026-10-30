import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hasQueueLifecycle } from './queue-history.mjs';
import { hasCronLifecycle } from './cron-history.mjs';
import { assertSnapshotAge, matchingSnapshot, queueRecoveryCapability } from './queue-snapshot.mjs';
import { cronRecoveryCapability, matchingCronSnapshot } from './cron-snapshot.mjs';

const refused = () => new Error('Background restoration requires matching paused snapshot evidence');
// Same protocol fields as the CLI background restore.
const families = [
  { recovery: 'queueRecovery', field: 'queueSnapshot', control: 'delivery', capability: queueRecoveryCapability, lifecycle: hasQueueLifecycle, match: matchingSnapshot, check: assertSnapshotAge },
  { recovery: 'cronRecovery', field: 'cronSnapshot', control: 'dispatch', capability: cronRecoveryCapability, lifecycle: hasCronLifecycle, match: matchingCronSnapshot },
];

export function backgroundSnapshots(source) {
  const recovered = [];
  for (const [name, app] of Object.entries(source.apps)) {
    if (app.retirement) continue;
    for (const family of families) {
      if (!family.lifecycle(app)) continue;
      if (app[family.recovery] && app[family.recovery].status !== 'acknowledged') throw refused();
      const receipt = app[family.field];
      if (!receipt) throw refused();
      family.match(source, name, receipt);
      recovered.push([name, family]);
    }
  }
  return recovered;
}

export function restorationBackgrounds(source, now = Date.now()) {
  const recovered = backgroundSnapshots(source);
  for (const [name, family] of recovered) family.check?.(source.apps[name][family.field], now);
  return recovered;
}

// The caller validates the original receipts and proves that the target fleet
// retains the same physical storage. Only the slot label changes; observation
// times, expiry and prior recovery history remain those of the source.
export function restoreBackgrounds(state, recovered, snapshot) {
  for (const [name, family] of recovered) {
    const app = state.apps[name];
    state.requirements = [...new Set([...state.requirements, family.capability])];
    app[family.recovery] = { id: randomUUID(), status: 'pending', snapshot,
      prepared: { ...structuredClone(app[family.field]), slot: app.slot }, previous: app[family.recovery] || null };
    delete app[family.field];
  }
}

export function archivedBackgrounds(record) {
  return backgroundSnapshots({ apps: { [record.name]: record.app }, deployments: record.deployments });
}

export function validateArchivedBackgrounds(state, record) {
  const app = state.apps[record.name];
  for (const [, family] of archivedBackgrounds(record)) {
    heldControl(app[family.control]);
    const receipt = app[family.recovery];
    const prepared = { ...record.app[family.field], slot: record.restoration.slot };
    if (Object.hasOwn(app, family.field) || !state.requirements.includes(family.capability) ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(receipt?.id) || receipt.status !== 'pending' ||
      receipt.snapshot !== record.restoration.snapshot || !isDeepStrictEqual(receipt.prepared, prepared) ||
      !isDeepStrictEqual(receipt.previous, record.app[family.recovery] || null)) throw refused();
  }
}

function heldControl(control) {
  if (control?.desired !== 'paused' || control.observed !== 'paused' || control.hold ||
    (control.operation && control.operation !== 'pause')) throw refused();
}
