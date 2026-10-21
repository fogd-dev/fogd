import assert from 'node:assert/strict';
import { releaseClient } from '../release/client.mjs';

const controls = { baseline: 'healthy', 'no-retry': 'no-retry', 'no-retry-future': 'healthy', 'owner-loss': 'owner-loss', terminal: 'terminal', 'terminal-future': 'healthy', downtime: 'healthy' };
const statements = new Set([
  'SELECT * FROM cron_fault_attempts ORDER BY entered_at,id;',
  'SELECT job,cron,scheduled_time,value,saved_at FROM refresh_results ORDER BY scheduled_time,job;',
  ...Object.entries(controls).map(([phase, policy]) => `UPDATE cron_fault_control SET policy = '${policy}', phase = '${phase}' WHERE id = 1 RETURNING *;`),
]);
export function failureClient(fixture) {
  const probe = releaseClient(fixture, sql => statements.has(sql));
  const observe = async (time, mode) => {
    probe.recordAccess('owner-window'); assert.ok(Number.isSafeInteger(time) && time > 0 && time % 60000 === 0);
    return JSON.parse(await probe.compose(['exec', '-T', 'controller', '/usr/local/bin/node', '/app/qualification/failure-observation.mjs', String(time), mode]));
  };
  probe.ownerSnapshot = time => observe(time, 'owner-loss');
  probe.ownerRecovery = time => observe(time, 'owner-recovery');
  return probe;
}
