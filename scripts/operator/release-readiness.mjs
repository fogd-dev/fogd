import { waitFor } from '../cron-probe/selected/https.mjs';

export async function receivedReplicaReadiness(host, app, active, record) {
  record.samples = [];
  return waitFor('received native replica facts before explicit HTTP resume', async () => {
    const report = await host.json(['observe', app, '--installation', host.project]);
    const routing = await host.json(['admin', 'routing', app, 'status']); record.samples.push({ report, routing });
    if (routing.state !== 'withheld' || routing.hold?.deployment !== active.id || routing.hold.digest !== active.digest) {
      throw Object.assign(new Error('Recovered HTTP selection changed before explicit resume'), { code: 'FOGD_SELECTION_EXPIRED' });
    }
    const replicas = report.replicas;
    return !routing.startupBlocked && routing.pending === null && report.runtimeIdentity === 'verified' && report.runtimeLeases === 'current' &&
      replicas.length === 2 && replicas.every(row => row.stateHTTPStatus === 200 && row.healthHTTPStatus === 200 && row.version === 'matches') && routing;
  }, 90000);
}
