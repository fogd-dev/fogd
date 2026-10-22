import { backgroundFixtures } from './background-fixtures.mjs';
import { nativeObservation, setFaultPolicy } from './observations.mjs';

export async function recoveryFixtures(host, request) {
  const fixture = await backgroundFixtures(host, request), active = fixture.approvals.refresh;
  await setFaultPolicy(host, active.slot, active.id, 'healthy', 'snapshot-a');
  return fixture;
}

export { importJob } from './background-fixtures.mjs';

export async function recoveredData(host, approvals) {
  const values = {};
  for (const name of ['refresh', 'imports']) {
    const active = approvals[name];
    values[name] = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
  }
  return values;
}

export function applicationData(observed) {
  return Object.fromEntries(Object.entries(observed).map(([name, value]) => [name,
    value.databases.map(database => ({ database: database.database, migrations: database.migrations, data: database.data }))]));
}
