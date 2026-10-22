import assert from 'node:assert/strict';
import { retireOriginalQueue } from './retirement-start.mjs';
import { importJob } from './recovery-fixtures.mjs';
import { nativeObservation } from './observations.mjs';
import { retiredQueueReplacement } from './retirement-replacement.mjs';
import { rows } from './recovery-ledger.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { prefixFingerprints } from '../../queue-probe/prefix-fingerprints.mjs';
import { assertControllerFiles } from '../retirement/preservation.mjs';
import { waitFor } from './https.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';

export async function firstRetirement(context) {
  const { evidence } = context;
  const { fixture, point, target, held } = await retireOriginalQueue(context);
  context.phase = 'fresh-queue-capacity';
  evidence.replacement = await retiredQueueReplacement(target, fixture, held.request, evidence.held.warmKeys[target.retirement.previous.slot]);
  const replacement = evidence.replacement.active; await importJob(held.request, 'fresh-input', 'melon\nplum', 'replacement');
  await target.command(['admin', 'delivery', 'replacement', 'resume', replacement.id, replacement.digest]);
  evidence.freshImport = await waitFor('new namespace input completes', async () => {
    const observed = await nativeObservation(target, replacement.slot, replacement.id, { persistedRecords: true, captureProofs: true });
    return rows(observed, 'import_jobs').some(row => row.id === 'fresh-input' && row.status === 'complete') && rows(observed, 'import_results').filter(row => row.job_id === 'fresh-input').length === 2 && observed.queuePeek.messages.length === 0 && observed;
  });
  evidence.freshImportKeys = verifiedObservationKeys(target.policy, replacement.slot, evidence.freshImport);
  assert.deepEqual(evidence.freshImportKeys, evidence.held.warmKeys[replacement.slot]);
  assert.deepEqual(rows(evidence.freshImport, 'import_results').map(row => row.label), ['MELON', 'PLUM']);
  evidence.retainedAfterReuse = await prefixFingerprints(target.compose, target.retirement.previous.prefix, true);
  assert.deepEqual(evidence.retainedAfterReuse, evidence.held.retainedBefore.imports.objects);
  await assertControllerFiles({ identity: { image: target.entry.image }, config: target.config }, evidence.held.privateFilesBefore);
  evidence.privacy = [];
  for (const app of ['refresh', 'imports']) evidence.privacy.push(await scanPublicSurfaces(target, held.request, [fixture.approvals[app]], fixture.tokens[app], [fixture.secret], evidence));
  evidence.privacy.push(await scanPublicSurfaces(target, held.request, [replacement], fixture.tokens.replacement, [fixture.secret], evidence));
  return { fixture, point, target, held };
}
