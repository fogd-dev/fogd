import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { startPreviewAllocation, previewShutdownLeadMs } from './startup.mjs';
import { stopPreviewAllocation, requestPreviewStop, inspectPreviewTermination } from './teardown.mjs';
import { readPreviewInputs } from './inputs.mjs';
import { assertCurrentPreviewSource } from './decision.mjs';

const pending = error => error.code === 'PREVIEW_HOST_REFUSED' && error.reason === 'pending';

// A pending refusal occurs before acquiring the fence or issuing any effect.
// Wait for that operation; never retry an uncertain command or partial write.
async function afterPending(work, expiresAt) {
  const until = performance.now() + previewShutdownLeadMs;
  for (;;) {
    try { return await work(); }
    catch (error) {
      if (!pending(error) || performance.now() >= until || Date.now() >= Date.parse(expiresAt)) throw error;
      await delay(100);
    }
  }
}

async function stopWithReason(input, reason, expiresAt) {
  const state = await afterPending(() => requestPreviewStop(input, { reason }), expiresAt);
  return state.completed || afterPending(() => stopPreviewAllocation(input), expiresAt);
}

function sourceMonitor(source, env) {
  const cancellation = new AbortController(); let next = 0, checking = false, failed = false;
  return {
    get failed() { return failed; },
    check() {
      if (checking || performance.now() < next) return;
      checking = true;
      void assertCurrentPreviewSource(source, env, { signal: cancellation.signal }).then(
        () => { checking = false; next = performance.now() + 1000; },
        () => { checking = false; failed = true; },
      );
    },
    close() { cancellation.abort(); },
  };
}

async function watch(input, ready, source) {
  const at = Date.parse(ready.shutdownAt), monotonic = performance.now() + Math.max(0, at - Date.now()), monitor = sourceMonitor(source, input.env);
  let nextIntentCheck = 0;
  try {
    for (;;) {
      if (input.signal?.aborted) return await stopWithReason(input, 'cancelled', ready.expiresAt);
      if (Date.now() >= at || performance.now() >= monotonic) return await stopWithReason(input, 'expiry', ready.expiresAt);
      if (performance.now() >= nextIntentCheck) {
        let state;
        try { state = await inspectPreviewTermination(input); }
        catch (error) { if (!pending(error)) throw error; }
        if (state?.completed) return state.completed;
        if (state?.request) return await afterPending(() => stopPreviewAllocation(input), ready.expiresAt);
        nextIntentCheck = performance.now() + 1000;
      }
      if (monitor.failed) return await stopWithReason(input, 'source-unverifiable', ready.expiresAt);
      monitor.check();
      try { await delay(100, undefined, { signal: input.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
  } finally { monitor.close(); }
}

// The watcher is scheduled before returning readiness. It converges on an
// existing complete stop, handles owner withdrawal and stops if the independently
// configured source can no longer verify the original proposal/baseline.
export async function runPreviewAllocation(input) {
  const { preparation, review } = await readPreviewInputs(input.directory, input.plan.request.preparationSha256);
  const ready = await startPreviewAllocation(input);
  const completion = watch(input, ready, { preparation, review });
  void completion.catch(() => {}); // The owner still observes the original result.
  return { ready, completion };
}
