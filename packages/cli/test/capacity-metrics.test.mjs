import test from 'node:test';
import assert from 'node:assert/strict';
import { bytes, inventory, unchanged, sample, summary } from '../../../scripts/capacity/metrics.mjs';
const containers = ['controller', 'minio', 'workerd', 'slot-1-a', 'slot-1-b'].map((service, i) => ({ id: `abcdef${i}`, service, running: true, restarts: 0, startedAt: '2026-10-18' }));
test('capacity measurements reject incomplete or changing installations', () => {
  assert.equal(inventory(containers).length, 5);
  assert.throws(() => inventory(containers.slice(0, -1)), /complete/);
  assert.throws(() => inventory([...containers, containers[0]]), /unique/);
  assert.throws(() => inventory(containers.map(c => ({ ...c, paused: true }))), /normally/);
  unchanged(containers, [...containers].reverse());
  assert.throws(() => unchanged(containers, containers.map(c => ({ ...c, id: c.id + 'new' }))), /changed/);
  assert.throws(() => unchanged(containers, containers.map(c => ({ ...c, startedAt: 'later' }))), /changed/);
  assert.throws(() => unchanged(containers, containers.map(c => ({ ...c, restarts: 1 }))), /changed/);
});
test('capacity statistics preserve units and aggregate simultaneous samples', () => {
  assert.equal(bytes('1.5MiB'), 1572864);
  assert.equal(bytes('1.5MB'), 1500000);
  assert.throws(() => bytes('NaNMiB'));
  const rows = containers.map(c => ({ ID: c.id, CPUPerc: '1.25%', MemUsage: '2MiB / 512MiB' }));
  const measured = sample(rows, inventory(containers));
  assert.equal(summary([{ containers: measured }]).total.memoryMaxBytes, 10 * 1024 ** 2);
  assert.equal(summary([{ containers: measured }]).shared.cpuMeanPercent, 3.75);
  assert.throws(() => sample(rows.map(r => ({ ...r, ID: 'a' })), containers), /Unknown/);
  assert.throws(() => sample(rows.map(r => ({ ...r, MemUsage: '--' })), containers), /memory/);
  assert.throws(() => sample(rows.slice(1), containers), /Incomplete/);
  assert.throws(() => sample(rows.map(() => rows[0]), containers), /duplicate/);
  assert.throws(() => sample(rows.map(r => ({ ...r, CPUPerc: '--' })), containers), /CPU/);
});
