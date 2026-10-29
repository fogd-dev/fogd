import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const read = async file => JSON.parse(await readFile(file, 'utf8'));

// Audited snapshot receipts retain the original host separately from the
// completed snapshot. Their lifecycle driver need not have passed in full.
export async function backgroundRecoverySource(directory) {
  const acceptedRoot = resolve(directory), original = await read(join(acceptedRoot, 'result.json'));
  const audited = original.kind === 'audited-native-background-snapshot';
  assert.ok(original.kind === undefined || audited, 'Unsupported background source receipt');
  if (audited) assert.equal(original.passed, true, 'An audited snapshot must have passed its final audit');
  assert.ok(original.evidence?.snapshot, 'A completed lifecycle snapshot is required');
  const sourceRoot = audited ? resolve(original.sourceRoot) : acceptedRoot;
  const inputs = await read(join(sourceRoot, 'inputs.json'));
  if (audited) assert.equal(inputs.project, original.project, 'Audited snapshot host differs from its input record');
  const bundle = join(acceptedRoot, 'stopped-snapshot');
  if (original.evidence.snapshot.bundle) assert.equal(resolve(original.evidence.snapshot.bundle), bundle, 'Snapshot differs from the selected evidence directory');
  const lifecycle = audited ? original.evidence.completedLifecycle : original.evidence;
  const approvals = { ...lifecycle.approvals.approvals, refresh: lifecycle.update.active };
  assert.deepEqual(Object.keys(approvals).sort(), ['imports', 'refresh']);
  for (const [app, active] of Object.entries(approvals)) assert.equal(active.app, app, 'Approval differs from its application');
  return { acceptedRoot, original, sourceRoot, inputs, bundle, approvals };
}
