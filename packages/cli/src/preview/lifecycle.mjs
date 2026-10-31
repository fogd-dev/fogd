import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { startPreviewAllocation } from './startup.mjs';
import { stopPreviewAllocation, completePreviewStop, inspectPreviewTermination } from './teardown.mjs';
import { readPreviewInputs } from './inputs.mjs';
import { assertCurrentPreviewSource } from './decision.mjs';

import { waitForPreviewFence as afterPending, previewFencePending as pending } from './pending-operation.mjs';
import { writePreviewOwnerControl } from './owner-control.mjs';

const stopWithReason = (input, reason, expiresAt) => completePreviewStop(input, { reason, expiresAt });

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
  const control = input.ownerControl ? await writePreviewOwnerControl(input, input.ownerControl) : null;
  const started = await startPreviewAllocation(input), ready = control ? { ...started, control } : started;
  const completion = watch(input, ready, { preparation, review });
  void completion.catch(() => {}); // The owner still observes the original result.
  return { ready, completion };
}
