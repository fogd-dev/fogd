import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { retainAndDown } from './lifecycle.mjs';

export async function runQualification(probes, output, run) {
  let failure;
  try { await run(); }
  catch (error) {
    failure = error;
    await writeFile(join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack }) + '\n', { mode: 0o600 });
  } finally {
    for (const probe of probes) {
      if (probe.closed) continue;
      try { await retainAndDown(probe, null, 'cleanup'); }
      catch (error) {
        failure ||= error;
        await writeFile(join(output, 'cleanup-failure.json'), JSON.stringify({ project: probe.project, message: error.message }) + '\n', { mode: 0o600 });
      }
    }
  }
  if (failure) throw failure;
}
