import { supportedDiagnosticController } from '../observe/controller-state.mjs';
import { supportedApplication } from '../controller-schema.mjs';
import { artifactPruneStatus } from '@fogd/platform/artifact-prune-state';
import { applicationInspection } from '../inspection.mjs';
import { observationKey } from '../observe/fingerprint.mjs';

export function logSelection(state, app, policy) {
  if (!supportedDiagnosticController(state, policy)) throw new Error('Replica log scope requires supported controller metadata');
  const item = Object.hasOwn(state.apps, app) ? state.apps[app] : null;
  if (!supportedApplication(item, ['queueSnapshot', 'cronSnapshot']) || item.retirement || item.quarantined) throw new Error('Replica log scope is unavailable for this application');
  const fleet = policy.fleets.find(value => value.id === item.slot);
  if (!fleet) throw new Error('Replica logs require an assigned application fleet');
  const publicState = state.artifactPruning ? { ...state, artifactPruning: artifactPruneStatus(state) } : state;
  const report = applicationInspection(publicState, app);
  return { app, fleet, key: observationKey(state, app), recorded: { routing: report.routing, active: report.active } };
}
