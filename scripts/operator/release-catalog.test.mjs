import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { releaseCatalog } from './release-transfer.mjs';
import { runtimeFamily } from '../../packages/cli/src/runtime/catalog.mjs';
import { programInputs } from '../../packages/cli/src/distribution/program.mjs';

const original = await readFile(new URL('../../packages/cli/src/runtime/catalog.json', import.meta.url));

test('private v7 proposal changes only selected admission and leaves the source closed', () => {
  const before = Buffer.from(original), entries = JSON.parse(original);
  const proposed = JSON.parse(releaseCatalog(original, 'celld-approval-v7-linux-arm64', false));
  const selected = entries.find(value => value.id === 'celld-approval-v7-linux-arm64');
  assert.equal(selected.admission, 'candidate'); selected.admission = 'qualified';
  assert.deepEqual(proposed, entries);
  assert.deepEqual(original, before);
  assert.throws(() => runtimeFamily(selected.id), /ordinary enrollment remains closed/);
});

test('actual qualified catalog keeps exact bytes and wrong admission/unknown selections refuse', () => {
  assert.equal(releaseCatalog(original, 'celld-durable-v5-linux-arm64', true), original);
  assert.throws(() => releaseCatalog(original, 'celld-approval-v7-linux-arm64', true));
  assert.throws(() => releaseCatalog(original, 'celld-durable-v5-linux-arm64', false));
  assert.throws(() => releaseCatalog(original, 'unknown-family', false), /Unknown release runtime family/);
});

test('operator transfer includes browser decision instructions without collecting evidence or reviews', async () => {
  const inputs = await programInputs(new URL('../../', import.meta.url).pathname);
  for (const path of ['docs/browser-release-review.md', 'docs/decision-history.md']) assert.ok(inputs.has(path));
  assert.ok(![...inputs.keys()].some(path => path.startsWith('docs/evidence/') || path.startsWith('docs/reviews/')));
});
