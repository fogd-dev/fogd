import test from 'node:test';
import assert from 'node:assert/strict';
import { archivedPrefixPaths } from './retirement-bucket.mjs';

test('retired namespace comparison includes exactly its archived subtree', () => {
  const listing = './\n./fogd/slots/one/\n./fogd/slots/one/object/\n./fogd/slots/one/object/xl.meta\n./fogd/slots/one-more/object/xl.meta\n./fogd/slots/two/object/xl.meta\n';
  assert.deepEqual(archivedPrefixPaths(listing, 'fogd', 'slots/one'), { root: 'fogd/slots/one', paths: ['fogd/slots/one', 'fogd/slots/one/object', 'fogd/slots/one/object/xl.meta'] });
});
for (const [name, listing, bucket, prefix] of [
  ['missing prefix', './fogd/other/object/xl.meta\n', 'fogd', 'slots/one'],
  ['empty prefix', './fogd/slots/one/\n', 'fogd', 'slots/one'],
  ['duplicate entry', './fogd/slots/one/\n./fogd/slots/one/object\n./fogd/slots/one/object\n', 'fogd', 'slots/one'],
  ['escaping member', './fogd/slots/one/\n./fogd/slots/one/../other\n', 'fogd', 'slots/one'],
  ['absolute prefix', '', 'fogd', '/slots/one'],
  ['escaping prefix', '', 'fogd', 'slots/../one'],
]) test(`retired namespace comparison refuses ${name}`, () => {
  assert.throws(() => archivedPrefixPaths(listing, bucket, prefix), { code: 'ERR_ASSERTION' });
});
