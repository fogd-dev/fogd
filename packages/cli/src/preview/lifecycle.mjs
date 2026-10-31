import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { startPreviewAllocation } from './startup.mjs';
import { stopPreviewAllocation } from './teardown.mjs';

async function untilShutdown(shutdownAt, signal) {
  const at = Date.parse(shutdownAt), monotonic = performance.now() + Math.max(0, at - Date.now());
  while (!signal?.aborted && Date.now() < at && performance.now() < monotonic) {
    try { await delay(Math.max(1, Math.min(100, at - Date.now(), monotonic - performance.now())), undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
}

// The watcher is scheduled before returning the ready URL. It stops once, in
// verified order, on cancellation or before the original per-service fallback.
// Manager loss/unknown shutdown retains the hold; no automatic memory retirement.
export async function runPreviewAllocation(input) {
  const ready = await startPreviewAllocation(input);
  const completion = untilShutdown(ready.shutdownAt, input.signal).then(() => stopPreviewAllocation(input));
  // Keep a paused consumer from causing an unhandled rejection. The original
  // rejecting promise remains available and must be observed by its owner.
  void completion.catch(() => {});
  return { ready, completion };
}
