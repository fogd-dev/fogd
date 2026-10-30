import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appName } from '@fogd/runtime/artifact';
import { retirementApp, overlap } from './retirement.mjs';
import { runtimePolicyIdentity, validateRuntimePolicy } from './runtime-policy.mjs';

export const appArchiveCapability = 'fogd-app-archive-v1';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const map = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, fields) => map(value) && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const refused = () => Object.assign(new Error('App archival requires exact retained identity, consistent state and a fresh stopped target; keep all writers stopped and retain all stores'), { code: 'APP_ARCHIVE_REFUSED' });
const immutableFields = ['schema', 'id', 'at', 'name', 'digest', 'snapshot', 'source', 'fleet', 'app', 'deployments', 'requirements'];
const withoutNetworks = ({ networks, ...profile }) => profile;
const canonical = value => Array.isArray(value) ? value.map(canonical) : map(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const identity = record => createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(immutableFields.map(key => [key, record[key]]))))).digest('hex');
const retained = state => Object.values(state.appArchives?.records || {}).filter(record => record.status === 'archived');
const retiredPrefixes = state => Object.values(state.apps).filter(app => app.retirement).map(app => app.retirement.previous.prefix);
const placeholder = record => ({ slot: null, route: 'archived', active: record.app.active, archive: record.id });

function header(state) {
  if (!map(state) || !map(state.apps) || !map(state.deployments) || !Array.isArray(state.requirements) || new Set(state.requirements).size !== state.requirements.length) throw refused();
  if (!Object.hasOwn(state, 'appArchives')) {
    if (state.requirements.includes(appArchiveCapability) || Object.values(state.apps).some(app => app.archive || app.archiveRecovery)) throw refused();
    return {};
  }
  if (!state.requirements.includes(appArchiveCapability) || !exact(state.appArchives, ['schema', 'records']) || state.appArchives.schema !== 1 || !map(state.appArchives.records)) throw refused();
  return state.appArchives.records;
}
function checkedRecord(record, id) {
  const extra = record?.status === 'restored' ? ['restoration'] : [];
  if (!exact(record, [...immutableFields, 'identity', 'status', ...extra]) || record.schema !== 1 || record.id !== id || !uuid(id) ||
    !['archived', 'restored'].includes(record.status) || !hex(record.identity) || identity(record) !== record.identity) throw refused();
  checkedOrigin(record); checkedSavedApp(record);
  if (record.status === 'restored') {
    if (!exact(record.restoration, ['snapshot', 'targetIdentity', 'slot']) || !hex(record.restoration.snapshot) || !hex(record.restoration.targetIdentity)) throw refused();
  }
}
function checkedOrigin(record) {
  appName(record.name);
  if (!hex(record.snapshot) || !hex(record.digest) || !Array.isArray(record.requirements) ||
    typeof record.at !== 'string' || new Date(record.at).toISOString() !== record.at ||
    !exact(record.source, ['family', 'image', 'storageImage', 'identity', 'bucket', 'storage']) || !hex(record.source.identity) ||
    !exact(record.fleet, ['id', 'prefix', 'nodes'])) throw refused();
}
function checkedSavedApp(record) {
  if (!map(record.app) || !map(record.deployments) || record.app.slot !== record.fleet.id || record.app.archive || record.app.retirement) throw refused();
  const active = record.deployments[record.app.active];
  if (!active || active.app !== record.name || active.digest !== record.digest || active.status !== 'active') throw refused();
  for (const [key, deployment] of Object.entries(record.deployments)) {
    if (!uuid(key) || deployment.id !== key || deployment.app !== record.name || deployment.status === 'activating') throw refused();
  }
}
function checkedPlaceholder(state, record) {
  if (!isDeepStrictEqual(state.apps[record.name], placeholder(record))) throw refused();
  for (const [key, original] of Object.entries(record.deployments)) {
    const expected = { ...original, status: ['active', 'pending', 'failed'].includes(original.status) ? 'archived' : original.status };
    if (!isDeepStrictEqual(state.deployments[key], expected)) throw refused();
  }
}
function checkedAppReferences(state, records) {
  for (const [name, app] of Object.entries(state.apps)) {
    if (app.archive && (!Object.hasOwn(records, app.archive) || records[app.archive].status !== 'archived' || records[app.archive].name !== name)) throw refused();
    if (app.route === 'archived' && !app.archive) throw refused();
    if (app.archiveRecovery) validateRecovery(records, name, app);
  }
}

// State consistency only. This cannot prove stopped writers, retained bytes or a
// completed filesystem copy; the stopped coordinator must establish those facts.
export function validateAppArchives(state, profile) {
  try {
    const records = header(state), policy = validateRuntimePolicy(profile), names = new Set(), prefixes = [];
    for (const [id, record] of Object.entries(records)) {
      checkedRecord(record, id);
      if (record.status !== 'archived') {
        validateRecovery(records, record.name, state.apps[record.name]);
        checkedRestoredFleet(record, policy);
        continue;
      }
      if (names.has(record.name)) throw refused();
      detachedArchive(record, policy, [...prefixes, ...retiredPrefixes(state)]);
      names.add(record.name); prefixes.push(record.fleet.prefix);
      checkedPlaceholder(state, record);
    }
    checkedAppReferences(state, records);
    return records;
  } catch { throw refused(); }
}
function detachedArchive(record, policy, prefixes) {
  if (prefixes.some(prefix => overlap(prefix, record.fleet.prefix)) || policy.fleets.some(fleet => overlap(fleet.prefix, record.fleet.prefix))) throw refused();
  const liveNodes = new Set(policy.fleets.flatMap(fleet => fleet.nodes.map(node => node.id)));
  if (record.fleet.nodes.some(node => liveNodes.has(node.id))) throw refused();
}

function checkedRestoredFleet(record, policy) {
  checkedSourceProfile(record, policy);
  const fleet = policy.fleets.find(value => value.id === record.restoration.slot);
  if (record.restoration.targetIdentity !== runtimePolicyIdentity(policy) || fleet?.prefix !== record.fleet.prefix ||
    !isDeepStrictEqual(fleet.nodes.map(node => node.id), record.fleet.nodes.map(node => node.id))) throw refused();
}

function checkedSourceProfile(record, profile) {
  if (record.source.family !== profile.family || record.source.image !== profile.image || record.source.storageImage !== profile.storageImage ||
    record.source.bucket !== profile.bucket || !isDeepStrictEqual(record.source.storage, profile.storage)) throw refused();
}

function validateRecovery(records, name, app) {
  const recovery = app?.archiveRecovery, record = recovery && records[recovery.archive];
  if (!exact(recovery, ['archive', 'identity', 'status']) || recovery.status !== 'pending' || !record || record.name !== name || record.status !== 'restored' ||
    record.identity !== recovery.identity || app.slot !== record.restoration.slot || app.active !== record.app.active || app.route !== 'paused') throw refused();
}
function profiles(source, target, slot, replacement) {
  const original = validateRuntimePolicy(source), next = validateRuntimePolicy(target);
  if (original.schema !== 3 || next.schema !== 3) throw refused();
  const expected = structuredClone(original), fleet = expected.fleets.find(value => value.id === slot);
  if (!fleet) throw refused();
  Object.assign(fleet, replacement);
  if (!isDeepStrictEqual(withoutNetworks(expected), withoutNetworks(next))) throw refused();
  return { original, next };
}
function archiveInput(input) {
  if (!exact(input, ['state', 'sourceProfile', 'profile', 'snapshot', 'app', 'digest', 'id', 'at']) || !hex(input.snapshot) || !uuid(input.id) ||
    typeof input.at !== 'string' || new Date(input.at).toISOString() !== input.at) throw refused();
  const records = validateAppArchives(input.state, input.sourceProfile);
  if (Object.hasOwn(records, input.id)) throw refused();
  const app = retirementApp(input.state, input.app, input.digest, {
    stopQueuedWork: Boolean(input.state.apps[input.app]?.resources?.queues),
    stopScheduledWork: Object.hasOwn(input.state.apps[input.app]?.resources || {}, 'crons'),
  });
  if (app.archiveRecovery || app.claim) throw refused();
  const source = validateRuntimePolicy(input.sourceProfile), fleet = source.fleets.find(value => value.id === app.slot);
  if (!fleet) throw refused();
  const replacement = { prefix: `archive-generations/${input.id}`, nodes: fleet.nodes.map(node => ({ ...node, id: `${node.host}-${input.id}` })) };
  const { next } = profiles(source, input.profile, app.slot, replacement);
  const reserved = [...retained(input.state).map(record => record.fleet.prefix), ...retiredPrefixes(input.state), ...source.fleets.map(value => value.prefix)];
  if (reserved.some(prefix => overlap(prefix, replacement.prefix))) throw refused();
  return { app, source, fleet, next };
}

export function projectAppArchive(input) {
  try {
    const { app, source, fleet, next } = archiveInput(input), state = structuredClone(input.state);
    const record = { schema: 1, id: input.id, at: input.at, name: input.app, digest: input.digest, snapshot: input.snapshot,
      source: { family: source.family, image: source.image, storageImage: source.storageImage, identity: runtimePolicyIdentity(source), bucket: source.bucket, storage: structuredClone(source.storage) },
      fleet: structuredClone(fleet), app: structuredClone(app),
      deployments: structuredClone(Object.fromEntries(Object.entries(state.deployments).filter(([, release]) => release.app === input.app))), requirements: [...state.requirements] };
    record.identity = identity(record); record.status = 'archived';
    state.requirements = [...new Set([...state.requirements, appArchiveCapability])];
    state.appArchives = { schema: 1, records: { ...state.appArchives?.records, [record.id]: record } };
    state.apps[input.app] = placeholder(record);
    for (const release of Object.values(state.deployments)) if (release.app === input.app && ['active', 'pending', 'failed'].includes(release.status)) release.status = 'archived';
    validateAppArchives(state, next);
    return state;
  } catch { throw refused(); }
}

function restorationInput(input) {
  if (!exact(input, ['state', 'sourceProfile', 'profile', 'snapshot', 'archive', 'expectedIdentity', 'slot']) || !hex(input.snapshot) || !hex(input.expectedIdentity)) throw refused();
  const records = validateAppArchives(input.state, input.sourceProfile), record = records[input.archive];
  if (!record || record.status !== 'archived' || record.identity !== input.expectedIdentity) throw refused();
  const source = validateRuntimePolicy(input.sourceProfile), target = source.fleets.find(fleet => fleet.id === input.slot);
  if (!target || Object.values(input.state.apps).some(app => app.slot === target.id)) throw refused();
  checkedSourceProfile(record, source);
  const replacement = { prefix: record.fleet.prefix, nodes: target.nodes.map((node, index) => ({ ...node, id: record.fleet.nodes[index].id })) };
  const { next } = profiles(source, input.profile, target.id, replacement);
  return { record, next };
}

// Reinstates only the archived app. Current credentials and all other controller
// data remain authoritative. The pending recovery gate must prevent execution;
// shipping runtimes reject this capability until the archive protocol is admitted.
export function projectAppArchiveRestore(input) {
  try {
    const { record, next } = restorationInput(input), state = structuredClone(input.state);
    state.appArchives.records[record.id].status = 'restored';
    state.appArchives.records[record.id].restoration = { snapshot: input.snapshot, targetIdentity: runtimePolicyIdentity(next), slot: input.slot };
    state.apps[record.name] = { ...structuredClone(record.app), slot: input.slot, route: 'paused',
      archiveRecovery: { archive: record.id, identity: record.identity, status: 'pending' } };
    for (const [id, release] of Object.entries(record.deployments)) state.deployments[id] = structuredClone(release);
    validateAppArchives(state, next);
    return state;
  } catch { throw refused(); }
}
