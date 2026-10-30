import { appArchiveRotationCapability, assertArchiveRotationsSettled } from './app-archive-rotation-state.mjs';
import { isDeepStrictEqual } from 'node:util';
import { appArchiveCapability, projectAppArchive, projectAppArchiveRestore, validateAppArchives } from './app-archive.mjs';
import { validateRouteSnapshot } from './route-snapshot.mjs';
import { routeRecordDigest } from './route-record-store.mjs';
import { prepareRouteRestoration, restorationBackgrounds, routePolicy } from './route-restoration-plan.mjs';
import { restoreRouteStores } from './route-restoration-store.mjs';

const refused = () => Object.assign(new Error('App archive routing requires a verified source pair and an exact stopped restoration plan; keep ingress stopped and retain all stores'), { code: 'APP_ARCHIVE_ROUTES_REFUSED' });
const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value) && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());

// Archived apps have no live routing representation. Validate their complete
// private protocol first, then give the existing route validator only its live
// application view. This view is never persisted or handed to a controller.
function routingView(state, excluded) {
  const apps = Object.fromEntries(Object.entries(state.apps).filter(([name, app]) => !app.archive && name !== excluded));
  return { ...state, apps, requirements: state.requirements.filter(capability => ![appArchiveCapability, appArchiveRotationCapability].includes(capability)) };
}
export function validateAppArchiveSnapshot(state, observed, profile, domain = 'localhost') {
  try {
    const records = validateAppArchives(state, profile);
    for (const [name, app] of Object.entries(state.apps)) {
      const route = observed.record.routes.find(route => route.host === `${name}.${domain}`);
      const hold = state.routeAuthority.holds[name];
      if (app.archive && (route || hold)) throw refused();
      if (app.archiveRecovery) recoveryRoute(state, app, route, hold, records, profile);
    }
    return validateRouteSnapshot(routingView(state), observed, profile, domain);
  } catch { throw refused(); }
}
function recoveryRoute(state, app, route, hold, records, profile) {
  const record = records[app.archiveRecovery.archive], release = state.deployments[app.active];
  const fleet = profile.fleets.find(fleet => fleet.id === app.slot);
  if (!isDeepStrictEqual(hold, { id: release.id, digest: release.digest }) || !route || route.state !== 'withheld' || route.slot !== app.slot ||
    fleet?.prefix !== record.fleet.prefix || !isDeepStrictEqual(fleet.nodes.map(node => node.id), record.fleet.nodes.map(node => node.id))) throw refused();
}
function settled(state, record, profile, holds) {
  const digest = routeRecordDigest(record, routePolicy(profile));
  state.routeAuthority = { schema: 1, installation: record.installation, holds, settled: { revision: record.revision, digest }, pending: null };
  return { record, digest };
}
function sourceInput(input, operation) {
  if (!exact(input, ['profile', 'sourceProfile', 'source', 'snapshot', 'binding', 'domain', operation]) || !exact(input.source, ['state', 'authority'])) throw refused();
  validateAppArchiveSnapshot(input.source.state, input.source.authority, input.sourceProfile, input.domain);
  // Check live background receipts before changing any app or routing identity.
  assertArchiveRotationsSettled(input.source.state);
  restorationBackgrounds(input.source.state);
}
function coldPeers(input, state, excluded) {
  const view = routingView(state, excluded), policy = routePolicy(input.profile);
  const holds = Object.fromEntries(Object.entries(state.routeAuthority.holds).filter(([name]) => Object.hasOwn(view.apps, name)));
  const record = { schema: 1, installation: policy.installation, revision: '1',
    routes: input.source.authority.record.routes.filter(route => route.host !== `${excluded}.${input.domain}`) };
  const authority = settled(view, record, input.profile, holds);
  const projected = prepareRouteRestoration({ profile: input.profile, sourceProfile: input.profile, source: { state: view, authority },
    snapshot: input.snapshot, binding: input.binding, domain: input.domain });
  return attachArchiveApps(projected, state);
}
function attachArchiveApps(projected, source) {
  const detached = Object.fromEntries(Object.entries(source.apps).filter(([name]) => !Object.hasOwn(projected.state.apps, name)));
  projected.state.apps = { ...projected.state.apps, ...structuredClone(detached) };
  projected.state.requirements = [...new Set([...projected.state.requirements, ...source.requirements])];
  return projected;
}

// Whole-installation recovery preserves detached archives and existing approval
// gates. It grants no new app restoration rights and pauses every live route.
export function prepareArchiveSnapshotRoutes(input) {
  try {
    if (!exact(input, ['profile', 'sourceProfile', 'source', 'snapshot', 'binding', 'domain']) || !exact(input.source, ['state', 'authority']) || input.profile?.schema !== 4 || input.sourceProfile?.schema !== 4) throw refused();
    const source = input.source.state;
    validateAppArchiveSnapshot(source, input.source.authority, input.sourceProfile, input.domain);
    assertArchiveRotationsSettled(source);
    const view = routingView(source);
    const projected = attachArchiveApps(prepareRouteRestoration({ ...input, source: { state: view, authority: input.source.authority } }), source);
    validateAppArchiveSnapshot(projected.state, { record: projected.record, digest: projected.state.routeAuthority.settled.digest }, input.profile, input.domain);
    return projected;
  } catch { throw refused(); }
}

export function prepareAppArchiveRoutes(input) {
  try {
    sourceInput(input, 'archive');
    if (!exact(input.archive, ['app', 'digest', 'id', 'at'])) throw refused();
    const state = projectAppArchive({ ...input.archive, state: input.source.state, sourceProfile: input.sourceProfile,
      profile: input.profile, snapshot: input.snapshot });
    const projected = coldPeers(input, state, input.archive.app);
    validateAppArchiveSnapshot(projected.state, { record: projected.record, digest: projected.state.routeAuthority.settled.digest }, input.profile, input.domain);
    return projected;
  } catch { throw refused(); }
}
export function prepareAppArchiveRestoreRoutes(input) {
  try {
    sourceInput(input, 'restore');
    if (!exact(input.restore, ['archive', 'expectedIdentity', 'slot'])) throw refused();
    const state = projectAppArchiveRestore({ ...input.restore, state: input.source.state, sourceProfile: input.sourceProfile,
      profile: input.profile, snapshot: input.snapshot });
    const name = state.appArchives.records[input.restore.archive].name, app = state.apps[name], release = state.deployments[app.active];
    const projected = coldPeers(input, state, name);
    projected.record.routes.push({ host: `${name}.${input.domain}`, state: 'withheld', slot: app.slot });
    projected.record.routes.sort((left, right) => left.host < right.host ? -1 : left.host > right.host ? 1 : 0);
    const holds = { ...projected.state.routeAuthority.holds, [name]: { id: release.id, digest: release.digest } };
    const authority = settled(projected.state, projected.record, input.profile, holds);
    validateAppArchiveSnapshot(projected.state, authority, input.profile, input.domain);
    return projected;
  } catch { throw refused(); }
}

export async function restoreAppArchiveStores(input, options) {
  return restoreRouteStores(input, prepareAppArchiveRoutes, options);
}
export async function restoreAppArchiveRecoveryStores(input, options) {
  return restoreRouteStores(input, prepareAppArchiveRestoreRoutes, options);
}
