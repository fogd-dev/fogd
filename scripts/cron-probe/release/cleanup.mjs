import { cleanupCronProbe } from '../../cron-probe-cleanup.mjs';

async function settle(session) {
  let timer;
  try { await Promise.race([session.wait(), new Promise(resolve => { timer = setTimeout(resolve, 60000); })]); }
  finally { clearTimeout(timer); }
}
async function pauseFailedSession(session, pendingGate) {
  const step = (await session.rawReceipt().catch(() => null))?.step;
  if (pendingGate || ['update-held', 'failed'].includes(step)) await settle(session);
  if (!session.terminal) {
    try { await session.command('pause'); }
    catch { await settle(session); }
  }
}
// Failure cannot release an approval gate. Give the broker time to persist its
// own failure pause before considering PID-verified termination.
export async function cleanupRelease({ probe, session, pendingGate, failure, browser, expectedRejection = false }) {
  try { await browser?.close(); }
  finally {
    if (failure && !session.terminal) await pauseFailedSession(session, pendingGate);
    if (!session.terminal) {
      try { await session.finish(); }
      catch { await settle(session); if (!session.terminal) await session.kill(); }
    }
    try { await cleanupCronProbe(probe, () => probe.cleanupPause()); }
    catch (error) { if (!failure || expectedRejection) throw error; console.error('Cleanup failed; the owned installation must remain stopped'); }
  }
}
