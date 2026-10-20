import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Diagnostics must not prevent disarming an uncertain publication.
export async function cleanupCronProbe(probe, disarm) {
  const failures = [];
  for (const task of [
    async () => writeFile(join(probe.output, 'runtime.log'), await probe.compose(['logs','--no-color']), {mode:0o600}),
    disarm,
  ]) {
    try { await task(); } catch (error) { failures.push(error); }
  }
  if (failures.length) {
    await probe.save('cleanup-failure', {messages:failures.map(error => error.message)});
    throw new AggregateError(failures, 'Cron probe cleanup failed; stop the disposable fleet');
  }
}
