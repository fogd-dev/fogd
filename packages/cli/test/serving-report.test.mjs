import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReads, servingReport, interferenceReads, samplingContinues } from '../../../scripts/capacity/serving-observer.mjs';

test('serving summary includes failures in latency and counts wrong bodies even with HTTP 200', () => {
  assert.deepEqual(summarizeReads([
    { startedMs: 10, finishedMs: 11, status: 200, correct: true },
    { startedMs: 10, finishedMs: 20, status: 200, correct: false },
    { startedMs: 10, finishedMs: 40, status: 503, correct: false },
    { startedMs: 10, finishedMs: 5010, status: 0, correct: false },
  ]), { requests: 4, errors: 3, statuses: { 0: 1, 200: 2, 503: 1 }, latencyMs: { p50: 10, p95: 5000, p99: 5000, max: 5000 } });
});
test('paired paths are summarized independently from interleaved observations', () => {
  const result = servingReport([
    { kind: 'direct', startedMs: 0, finishedMs: 3, status: 200, correct: true },
    { kind: 'gateway', startedMs: 2, finishedMs: 12, status: 503, correct: false },
  ]);
  assert.equal(result.direct.errors, 0); assert.equal(result.direct.latencyMs.max, 3);
  assert.equal(result.gateway.errors, 1); assert.equal(result.gateway.latencyMs.max, 10);
});
for (const [name, samples] of [
  ['empty', []],
  ['reversed time', [{ startedMs: 2, finishedMs: 1, status: 200, correct: true }]],
  ['missing body check', [{ startedMs: 0, finishedMs: 1, status: 200 }]],
  ['nonfinite time', [{ startedMs: 0, finishedMs: Infinity, status: 200, correct: true }]],
]) test(`invalid observation evidence refuses a summary: ${name}`, () => {
  assert.throws(() => summarizeReads(samples), /no samples|Invalid serving sample/);
});

test('interference summary includes requests crossing either boundary and excludes unrelated warmup', () => {
  const report = { startedMs: 0, finishedMs: 100, markers: { start: 20, end: 60 }, samples: [
    { kind: 'gateway', startedMs: 0, finishedMs: 5, status: 200, correct: true },
    { kind: 'gateway', startedMs: 10, finishedMs: 30, status: 503, correct: false },
    { kind: 'direct', startedMs: 40, finishedMs: 80, status: 200, correct: true },
    { kind: 'gateway', startedMs: 60, finishedMs: 90, status: 200, correct: true },
  ] };
  const result = interferenceReads(report);
  assert.equal(result.gateway.requests, 1); assert.equal(result.gateway.errors, 1); assert.equal(result.gateway.latencyMs.max, 20);
  assert.equal(result.direct.requests, 1); assert.equal(result.direct.latencyMs.max, 40);
});

for (const [name, markers] of [
  ['missing', {}], ['reversed', { start: 10, end: 5 }], ['before window', { start: -1, end: 50 }], ['after window', { start: 10, end: 101 }],
]) test(`invalid interference markers cannot justify overlap claims: ${name}`, () => {
  assert.throws(() => interferenceReads({ startedMs: 0, finishedMs: 100, markers, samples: [] }), /outside the observed window/);
});

for (const [scenario, now, markers, expected] of [
  ['idle before minimum', 9000, {}, true],
  ['idle at minimum', 10000, {}, false],
  ['action exceeds minimum', 12000, { start: 2000 }, true],
  ['unfinished action at hard cap', 30000, { start: 2000 }, false],
  ['recovery tail is retained', 12000, { start: 2000, end: 8000 }, true],
  ['recovery tail finishes', 13000, { start: 2000, end: 8000 }, false],
  ['hard cap bounds a late tail', 30000, { start: 2000, end: 29000 }, false],
]) test(`sampling window: ${scenario}`, () => {
  assert.equal(samplingContinues(now, markers, 10000, 30000), expected);
});
