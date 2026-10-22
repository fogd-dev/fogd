import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeObservation } from './observations.mjs';
import { sourceInventory, sourceState } from './evidence.mjs';
import { scanPublicSurfaces, scanOutputFiles } from './privacy.mjs';
import { stopSelectedHost } from './shutdown.mjs';

export async function failureDiagnosticReceipt(host, fixture, record, rawSurfaces = []) {
  const identities = [];
  for (const fleet of host.policy.fleets) identities.push(await nativeObservation(host, fleet.id, undefined, { captureProofs: true }));
  const receipt = { ...record, family: host.entry.id, image: host.entry.image, policy: host.policy, approvals: fixture.approvals, identities, privacy: [] };
  for (const app of ['refresh', 'imports']) receipt.privacy.push(await scanPublicSurfaces(host, fixture.request, fixture.submissions?.[app] || [fixture.approvals[app]], fixture.tokens[app], [fixture.secret], receipt));
  receipt.shutdown = await stopSelectedHost(host); host.closed = true;
  receipt.finalPrivacy = await scanOutputFiles([host], fixture, receipt, rawSurfaces);
  assert.deepEqual(await sourceInventory(), record.sources); assert.deepEqual(await sourceState(), record.provenance);
  const file = join(host.output, 'result.json');
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const bytes = await readFile(file), scan = await scanOutputFiles([host], fixture, JSON.parse(bytes), [...rawSurfaces, bytes]);
  await writeFile(join(host.output, 'post-write-privacy.json'), JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), ...scan }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return receipt;
}
