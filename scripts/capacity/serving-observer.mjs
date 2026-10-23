import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export function summarizeRequests(samples) {
  if (!Array.isArray(samples) || !samples.length) throw new Error('Serving measurement has no samples');
  const durations = [], statuses = {}; let errors = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.startedMs) || !Number.isFinite(sample.finishedMs) || sample.finishedMs < sample.startedMs || typeof sample.correct !== 'boolean' || !Number.isInteger(sample.status) || sample.status < 0 || sample.status > 599) throw new Error('Invalid serving sample');
    durations.push(sample.finishedMs - sample.startedMs);
    statuses[sample.status] = (statuses[sample.status] || 0) + 1;
    if (sample.status !== 200 || !sample.correct) errors++;
  }
  durations.sort((a, b) => a - b);
  const percentile = fraction => durations[Math.ceil(durations.length * fraction) - 1];
  return { requests: samples.length, errors, statuses, latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: durations.at(-1) } };
}

export function servingReport(samples) {
  if (!Array.isArray(samples) || samples.some(sample => !['gateway', 'direct'].includes(sample?.kind))) throw new Error('Unknown serving sample path');
  return Object.fromEntries(['gateway', 'direct'].map(kind => [kind, summarizeRequests(samples.filter(sample => sample.kind === kind))]));
}

const workloads = {
  reads: settings => ({ method: 'GET', path: '/api/messages', metadata: {},
    correct: bytes => createHash('sha256').update(bytes).digest('hex') === settings.bodySha256 }),
  writes: writeOperation,
};
function writeOperation(settings, writeId) {
  if (typeof writeId !== 'string' || !/^[a-z0-9-]{1,96}$/.test(writeId)) throw new Error('Invalid serving write identity');
  return { method: 'POST', path: '/api/write-probe', metadata: { writeId }, body: JSON.stringify({ id: writeId }),
    correct: bytes => { try { const value = JSON.parse(bytes); return value.id === writeId && value.app === (settings.app || 'baseline'); } catch { return false; } } };
}

export async function observeServing(settings, kind, writeId) {
  const began = performance.now();
  if (!Object.hasOwn(workloads, settings.workload || 'reads')) throw new Error('Unknown serving workload');
  const profile = workloads[settings.workload || 'reads'];
  const target = settings.targets[kind], operation = profile(settings, writeId), appHost = `${settings.app || 'baseline'}.localhost`;
  return new Promise(resolve => {
    let settled = false;
    const finish = (status, correct) => {
      if (settled) return; settled = true;
      resolve({ kind, ...operation.metadata, startedMs: began, finishedMs: performance.now(), status, correct });
    };
    const transport = kind === 'gateway' ? httpsRequest : httpRequest;
    const req = transport({ hostname: target, port: settings.port || 8080, path: operation.path, method: operation.method,
      ca: settings.ca, servername: appHost, headers: { Host: appHost, 'x-forwarded-host': appHost, 'x-forwarded-proto': 'https', ...(operation.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(5000) }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) req.destroy(new Error('Response bound exceeded'));
        else chunks.push(chunk);
      });
      response.on('end', () => finish(response.statusCode, operation.correct(Buffer.concat(chunks))));
      response.on('error', () => finish(response.statusCode, false));
    });
    req.on('error', () => finish(0, false)); req.end(operation.body);
  });
}

async function run(settings) {
  validateWorkload(settings);
  const markers = {}, server = await markerServer(markers), resourcesBefore = resources();
  const samples = [], startedAt = new Date().toISOString(), startedMs = performance.now(), deadline = startedMs + settings.durationMs, maximumEnd = startedMs + settings.maxDurationMs;
  console.log(JSON.stringify({ ready: true, startedAt, startedMs }));
  await Promise.all(['gateway', 'direct'].flatMap(kind => Array.from({ length: settings.concurrency }, async (_, worker) => {
    let sequence = 0;
    while (samplingContinues(performance.now(), markers, deadline, maximumEnd)) { samples.push(await observeServing(settings, kind, `${settings.phase}-${kind}-${worker}-${sequence++}`)); await delay(100); }
  })));
  await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), startedMs, finishedMs: performance.now(), concurrencyPerPath: settings.concurrency, delayPerWorkerMs: 100, keepAlive: true, minimumWindowMs: settings.durationMs, maximumSchedulingWindowMs: settings.maxDurationMs, postActionTailMs: 5000,
    truncated: markers.start !== undefined && (markers.end === undefined || markers.end + 5000 > maximumEnd),
    summaries: servingReport(samples), markers, resourcesBefore, resourcesAfter: resources(), samples }));
  if (markers.start !== undefined && (markers.end === undefined || markers.end + 5000 > maximumEnd)) process.exitCode = 1;
}
if (process.argv[1] === '-') await run(JSON.parse(process.argv[2]));

async function markerServer(markers) {
  const server = createServer((req, res) => {
    const key = req.url === '/start' ? 'start' : req.url === '/end' ? 'end' : null;
    if (req.method !== 'POST' || !key || markers[key] !== undefined || (key === 'end' && markers.start === undefined)) { res.writeHead(400); res.end(); return; }
    markers[key] = performance.now(); res.end(JSON.stringify({ key, time: markers[key] }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(9080, '127.0.0.1', resolve); });
  return server;
}

export function interferenceRequests(report) {
  const { start, end } = report.markers;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < report.startedMs || end <= start || end > report.finishedMs) throw new Error('Interference is outside the observed window');
  return Object.fromEntries(['gateway', 'direct'].map(kind => {
    const samples = report.samples.filter(sample => sample.kind === kind && sample.startedMs < end && sample.finishedMs > start);
    return [kind, summarizeRequests(samples)];
  }));
}

function resources() {
  return Object.fromEntries(['memory.current', 'memory.peak', 'cpu.stat'].map(name => [name, readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim()]));
}

export function samplingContinues(now, markers, minimumEnd, maximumEnd) {
  return now < maximumEnd && (now < minimumEnd || (markers.start !== undefined && (markers.end === undefined || now < markers.end + 5000)));
}

function validateWorkload(settings) {
  if (!Number.isInteger(settings.durationMs) || settings.durationMs < 1000 || settings.durationMs > 120000 || !Number.isInteger(settings.concurrency) || settings.concurrency < 1 || settings.concurrency > 8 || !Number.isInteger(settings.maxDurationMs) || settings.maxDurationMs < settings.durationMs || settings.maxDurationMs > 300000) throw new Error('Invalid serving workload');
  if (!Object.hasOwn(workloads, settings.workload || 'reads') || (settings.workload === 'writes' && !/^[a-z0-9-]{1,48}$/.test(settings.phase || ''))) throw new Error('Invalid serving workload profile');
}
