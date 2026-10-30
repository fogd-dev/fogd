import { prepareRouteRestoration } from './route-restoration-plan.mjs';
import { prepareRetiredRouteRestoration } from './route-retirement-restoration.mjs';
import { restoreRouteStores } from './route-restoration-store.mjs';
export { prepareRouteRestoration, prepareRetiredRouteRestoration };

export async function restoreEnrolledRouteStores(input, options) {
  return restoreRouteStores(input, prepareRouteRestoration, options);
}

export async function restoreRetiredRouteStores(input, options) {
  return restoreRouteStores(input, prepareRetiredRouteRestoration, options);
}
