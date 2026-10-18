import { open } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' }, output: { type: 'string' }, seconds: { type: 'string', default: '120' }, concurrency: { type: 'string', default: '4' }, delay: { type: 'string', default: '100' } } });
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled');
let url;
try { url = new URL(values.url); }
catch { throw new Error('Use --url with an explicit HTTP(S) endpoint'); }
const seconds = Number(values.seconds), concurrency = Number(values.concurrency), delay = Number(values.delay);
if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an explicit HTTP(S) URL without credentials, query, or fragment');
if (!values.output || !Number.isInteger(seconds) || seconds < 1 || seconds > 600 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32 || !Number.isInteger(delay) || delay < 100 || delay > 10000) throw new Error('Use --url URL --output FILE [--seconds 1..600 --concurrency 1..32 --delay 100..10000 milliseconds]');
const reportFile = await open(values.output, 'wx', 0o600);
try {
  const startedAt = new Date().toISOString(), start = performance.now(), deadline = start + seconds * 1000;
  const latencies = [], statuses = {};
  let errors = 0, responseBytes = 0;
  async function request() {
    const began = performance.now();
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
      statuses[response.status] = (statuses[response.status] || 0) + 1;
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('Response exceeds 1 MiB workload bound');
      }
      responseBytes += size;
      if (response.status !== 200) errors++;
    } catch { errors++; }
    latencies.push(performance.now() - began);
  }
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) { await request(); await setTimeout(delay); }
  }));
  const elapsedMs = performance.now() - start;
  latencies.sort((a, b) => a - b);
  const percentile = p => latencies[Math.ceil(latencies.length * p) - 1];
  const report = { url: url.href, method: 'GET', startedAt, finishedAt: new Date().toISOString(), elapsedMs, concurrency, delayPerWorkerMs: delay, requests: latencies.length, errors, statuses, responseBytes, requestsPerSecond: latencies.length * 1000 / elapsedMs, latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: latencies.at(-1) }, caveat: 'Closed-loop paced read workload, not saturation or capacity limit. Latency includes response body consumption and failed requests. Operator must choose a read-only endpoint.' };
  await reportFile.writeFile(`${JSON.stringify(report, null, 2)}\n`);
  await reportFile.sync();
  console.log(JSON.stringify(report, null, 2));
  if (errors) process.exitCode = 1;
} finally { await reportFile.close(); }
