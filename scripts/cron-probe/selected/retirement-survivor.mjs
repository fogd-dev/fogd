import { join } from 'node:path';
import { preserveSource } from './recovery-snapshot.mjs';
import { recoveryTarget } from './recovery-target.mjs';
import { coldRecovery, acknowledgeRecovery } from './recovery-holds.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { verifyNativeTimingEnvironment } from '../sealed/defaults.mjs';

import { selectedTrial } from './selected-trial.mjs';
import { firstRetirement } from './retirement-first.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/retirement-survivor.mjs NEW_PRIVATE_OUTPUT');
await selectedTrial(process.argv[2], 'Selected active-cron survivor retirement and fresh queue capacity diagnostic only. Pending-retry/two-cron/full retirement acceptance and public admission remain open.', async context => {
  const { source, installations, evidence } = context;
  const { fixture, point, target } = await firstRetirement(context);
  context.phase = 'target-shutdown'; evidence.targetShutdown = await stopSelectedHost(target); target.closed = true;
  context.phase = 'original-source-audit';
  const audit = await recoveryTarget(source, point.bundle, join(source.output, 'original-source-audit'), installations, point.manifest.images); installations.push(audit);
  evidence.audit = { project: audit.project, policy: audit.policy, initialServices: audit.initialServices, cold: await coldRecovery(audit, point, installations) };
  evidence.auditTiming = await verifyNativeTimingEnvironment({ ...audit, slots: audit.policy.fleets.map(fleet => ({ nodes: fleet.nodes.map(node => node.host) })) });
  evidence.audit.acknowledged = await acknowledgeRecovery(audit, point, installations);
  evidence.auditShutdown = await stopSelectedHost(audit); audit.closed = true; evidence.sourcePreservation = await preserveSource(source, point);
  return fixture;
});
