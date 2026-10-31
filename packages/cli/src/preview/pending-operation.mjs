import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

// Only this refusal precedes acquiring the fence or issuing an effect. Unknown
// Docker results and partial writes must propagate without another attempt.
export const previewFencePending = error => error.code === 'PREVIEW_HOST_REFUSED' && error.reason === 'pending';
export async function waitForPreviewFence(work, expiresAt) {
  const until = performance.now() + 30000;
  for (;;) {
    try { return await work(); }
    catch (error) {
      if (!previewFencePending(error) || performance.now() >= until || Date.now() >= Date.parse(expiresAt)) throw error;
      await delay(100);
    }
  }
}
