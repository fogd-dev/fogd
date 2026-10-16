import test from 'node:test';
import assert from 'node:assert/strict';
import { adminDeployment } from '../src/admin-view.mjs';

test('private runtime version hashes stay out of API views without altering recovery state', () => {
  const request = { id: 'release', secretRevision: 'revision', version: 'hash-containing-private-config' };
  assert.deepEqual(adminDeployment(request), { id: 'release', secretRevision: 'revision' });
  assert.equal(request.version, 'hash-containing-private-config');
});
