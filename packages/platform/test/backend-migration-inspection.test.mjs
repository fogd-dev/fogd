import test from 'node:test';
import assert from 'node:assert/strict';
import { Backend } from '../src/backend.mjs';

const slot = { id: 'slot-2', prefix: 'slots/slot-1', nodes: ['slot-2-a', 'slot-2-b'] };
const resources = { d1: [{ database_name: 'demo-records', database_id: 'records' }] };
test('migration inspection selects existing rows without creating a missing ledger', async () => {
  const backend = Object.create(Backend.prototype);
  backend.run = async (selected, args) => {
    assert.deepEqual(selected, slot);
    assert.deepEqual(args, ['d1', 'execute', 'demo-records', '--command', 'SELECT name FROM d1_migrations;', '/artifact', '--json']);
    return '{"name":"0001_initial.sql"}\n';
  };
  assert.deepEqual(await backend.inspectMigrations(slot, '/artifact', resources), [{ database: 'records', name: '0001_initial.sql' }]);
});
test('migration inspection propagates a missing native ledger instead of manufacturing empty history', async () => {
  const backend = Object.create(Backend.prototype);
  backend.run = async () => { throw Object.assign(Error('no such table: d1_migrations'), { code: 'D1_QUERY_FAILED' }); };
  await assert.rejects(backend.inspectMigrations(slot, '/artifact', resources), { code: 'D1_QUERY_FAILED' });
});
