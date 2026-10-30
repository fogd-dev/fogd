import { appArchiveCapability } from './app-archive.mjs';
import { prepareArchiveSnapshotRoutes } from './app-archive-routes.mjs';
import { prepareRouteRestoration } from './route-restoration-plan.mjs';
import { prepareRetiredRouteRestoration } from './route-retirement-restoration.mjs';
import { restoreRouteStores } from './route-restoration-store.mjs';
export { prepareRouteRestoration, prepareRetiredRouteRestoration };

export function prepareSnapshotRouteRestoration(input) {
  if (input?.profile?.schema === 4) return prepareArchiveSnapshotRoutes(input);
  const state = input?.source?.state;
  if (state && (Object.hasOwn(state, 'appArchives') || state.requirements?.includes(appArchiveCapability) ||
    Object.values(state.apps || {}).some(app => app?.archive || app?.archiveRecovery || app?.route === 'archived'))) {
    throw Object.assign(new Error('Archive snapshot restoration requires the fixed archive runtime mode'), { code: 'ROUTE_RESTORATION_REFUSED' });
  }
  return prepareRouteRestoration(input);
}
export async function restoreEnrolledRouteStores(input, options) {
  return restoreRouteStores(input, prepareSnapshotRouteRestoration, options);
}

export async function restoreRetiredRouteStores(input, options) {
  return restoreRouteStores(input, prepareRetiredRouteRestoration, options);
}
