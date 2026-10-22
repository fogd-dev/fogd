import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { recoveryFixtures, importJob } from './recovery-fixtures.mjs';
import { waitFor } from './https.mjs';
import { resumeCron, armedTimer } from './recovery-work.mjs';
import { normalSnapshot } from './recovery-snapshot.mjs';
import { nativeProcesses } from './recovery-fence.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/recovery-source-smoke.mjs PRIVATE_OUTPUT_DIRECTORY');
const host = await selectedHost(process.argv[2]); let phase = 'fixtures';
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  const fixture = await recoveryFixtures(host), { approvals, request } = fixture;
  await importJob(request, 'before-a', 'apple\npear');
  await waitFor('original queued input', async () => {
    const response = await request('/api/imports?id=before-a', { app: 'imports' });
    return response.status === 200 && response.json().status === 'complete';
  });
  host.nativeBaseline = await nativeProcesses(host); phase = 'arm-due-timer';
  await resumeCron(host, approvals.refresh); const armed = await armedTimer(host, approvals.refresh);
  phase = 'normal-backup'; const point = await normalSnapshot(host, fixture, join(host.output, 'snapshot-a'), armed.status.nextAlarm, [host]);
  await writeFile(join(host.output, 'result.json'), JSON.stringify({ scope: 'Selected recovery source and armed backup smoke only; no restore acceptance', project: host.project,
    approvals, armed, before: point.before, prepared: point.prepared, snapshot: point.manifest, policy: host.policy }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('PASS-selected-recovery-source-smoke');
} catch (error) {
  await writeFile(join(host.output, 'failure.json'), JSON.stringify({ phase, name: error.name, message: error.message }, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); throw error;
} finally { clearInterval(heartbeat); if (!host.closed) await cleanupSelectedHost(host); }
