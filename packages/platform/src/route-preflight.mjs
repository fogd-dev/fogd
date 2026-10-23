import { isDeepStrictEqual } from 'node:util';
import { completedRoute, applicationWithheld, routeHold } from './route-publication.mjs';

const refused = () => Object.assign(new Error('HTTP routing preflight is unconfirmed; keep ingress stopped'), { code: 'ROUTE_PREFLIGHT_UNCONFIRMED' });
function challenge(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'challenge') ||
    typeof input.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(input.challenge)) throw new Error('Routing preflight requires exactly one 64-character hexadecimal challenge');
  return input.challenge;
}
function application(controller, route) {
  const suffix = '.' + controller.baseDomain;
  if (!route.host.endsWith(suffix)) throw refused();
  const name = route.host.slice(0, -suffix.length), app = controller.state.apps[name];
  if (!app || app.retirement || app.slot !== route.slot) throw refused();
  return { name, app };
}
function held(controller, name, app) {
  return applicationWithheld(app) || Boolean(routeHold(controller.state.routeAuthority.holds, name));
}
function serving(controller, record) {
  const active = [];
  for (const route of record.routes) {
    const { name, app } = application(controller, route), withheld = held(controller, name, app);
    if (route.state === 'withheld') { if (!withheld) throw refused(); continue; }
    if (withheld || !isDeepStrictEqual(completedRoute(controller.state, name, controller.baseDomain), route)) throw refused();
    const release = controller.state.deployments[route.submission];
    active.push({ name, route, version: release.version, secretRevision: release.secretRevision });
  }
  for (const [name, app] of Object.entries(controller.state.apps)) {
    if (!app.retirement && !held(controller, name, app) && !active.some(value => value.name === name)) throw refused();
  }
  return structuredClone(active);
}
// The controller serializes this with backend work. The result describes an
// observation interval, not a route grant or evidence about actual launch mounts.
export async function preflightRoutes(controller, routes, input) {
  const nonce = challenge(input);
  try {
    if (controller.routingServiceRestricted) throw refused();
    await routes.checkReady();
    const before = await routes.publication.inspect(), active = serving(controller, before.record);
    for (const value of active) await routes.options.verifyRuntime(value.name, { id: value.route.submission, digest: value.route.digest });
    await routes.checkReady();
    const after = await routes.publication.inspect();
    if (before.digest !== after.digest || !isDeepStrictEqual(active, serving(controller, after.record))) throw refused();
    return { schema: 1, challenge: nonce, authority: { record: after.record, sha256: after.digest }, observedActiveHosts: active.map(value => value.route.host) };
  } catch { throw refused(); }
}
