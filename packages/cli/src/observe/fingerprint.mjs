import { createHash } from 'node:crypto';
export function observationKey(state, name) {
  const app = Object.hasOwn(state.apps, name) ? state.apps[name] : null;
  const release = app?.active && Object.hasOwn(state.deployments, app.active) ? state.deployments[app.active] : null;
  return createHash('sha256').update(JSON.stringify({ app, release, requirements: state.requirements, artifactPruning: state.artifactPruning, routeAuthority: state.routeAuthority })).digest('hex');
}
