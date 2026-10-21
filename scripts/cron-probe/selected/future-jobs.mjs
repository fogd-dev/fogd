import assert from 'node:assert/strict';
import { controllerState, nativeObservation } from './observations.mjs';
import { waitFor } from './https.mjs';

export async function futureJobs(host, submitted, since) {
  const state = await controllerState(host), slot = state.apps.refresh.slot;
  const observation = await waitFor('autonomous future jobs on the approved release', async () => {
    const value = await nativeObservation(host, slot, submitted.id);
    const rows = value.databases.flatMap(database => database.data.refresh_occurrences || []);
    const results = value.databases.flatMap(database => database.data.refresh_results || []);
    return ['inventory', 'advisory'].every(job => rows.some(row => row.job === job && row.status === 'complete' && row.scheduled_time > since &&
      results.some(result => result.job === job && result.scheduled_time === row.scheduled_time && result.value.startsWith(submitted.label + ':')))) && value;
  }, 150000);
  assert.equal(observation.status.paused, false);
  assert.equal(observation.stored.manifest.version, state.deployments[submitted.id].version);
  return observation;
}

export function occurrenceKeys(observation) {
  return observation.databases.flatMap(database => (database.data.refresh_occurrences || []).map(row => `${database.database}:${row.job}:${row.cron}:${row.scheduled_time}`)).sort();
}

export function ledgerRows(observation) {
  return observation.databases.map(database => ({ database: database.database,
    occurrences: database.data.refresh_occurrences || [], results: database.data.refresh_results || [] }));
}
