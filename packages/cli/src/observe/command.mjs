import { parseArgs } from 'node:util';
import { appName } from '@fogd/runtime/artifact';
import { projectName } from '../recovery/docker.mjs';
import { observationInstallation, readObservationState, observationNetwork } from './installation.mjs';
import { observationKey } from './fingerprint.mjs';
import { observationSelection, observationReport } from './model.mjs';
import { sampleNative, ObserverCleanupError } from './runner.mjs';

export async function observeCommand(args, qualification = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { installation: { type: 'string' } } });
  if (positionals.length !== 1 || !values.installation) throw new Error('Usage: fogd observe APP --installation PROJECT (local Docker owner access)');
  const app = appName(positionals[0]), project = projectName(values.installation);
  const installation = await observationInstallation(project, qualification), state = await readObservationState(installation);
  const selection = observationSelection(state, app, installation.policy);
  let sample = null, boundary = 'single-read', controllerProcess = 'unconfirmed';
  if (!selection.reason) {
    boundary = 'matched-at-boundaries';
    try {
      const before = await observationNetwork(installation, selection.fleet);
      sample = await sampleNative(installation, selection, before.network);
      const after = await observationNetwork(installation, selection.fleet);
      controllerProcess = before.controller === 'running' && after.controller === 'running' ? 'running-at-boundaries' : [before.controller, after.controller].includes('not-running') ? 'not-running' : 'unconfirmed';
    }
    catch (error) { if (error instanceof ObserverCleanupError) throw error; sample = { ...sample, unavailable: 'scope-unconfirmed' }; }
    try { if (observationKey(await readObservationState(installation), app) !== selection.key) boundary = 'changed'; }
    catch { boundary = 'unavailable'; }
  }
  console.log(JSON.stringify(observationReport(selection, { installation: project, boundary, controllerProcess, observedAt: new Date().toISOString() }, sample), null, 2));
}
