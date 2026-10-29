import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactComparison } from '../src/artifact-comparison.mjs';

test('declaration comparison identifies changed resource categories and secret names without treating retained names as changes', () => {
  const before = { files: [], release: { resources: { script: 'app', r2: [] }, requiredSecrets: ['KEPT', 'OLD'], migrations: [] } };
  const after = { files: [], release: { resources: { script: 'app', r2: [{ binding: 'FILES', bucket_name: 'app-files' }] }, requiredSecrets: ['KEPT', 'NEW'], migrations: [] } };
  assert.deepEqual(artifactComparison(before, after).changedDeclarations, { resources: ['r2'], requiredSecrets: { added: ['NEW'], removed: ['OLD'] } });
});
test('a first artifact names every declared category and required secret as new in the artifact comparison', () => {
  const after = { files: [], release: { resources: { script: 'app', r2: [] }, requiredSecrets: ['API_KEY'], migrations: [] } };
  assert.deepEqual(artifactComparison(null, after).changedDeclarations, { resources: ['r2', 'script'], requiredSecrets: { added: ['API_KEY'], removed: [] } });
});
