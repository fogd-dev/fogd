import { cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateRefreshProject } from '../refresh-project.mjs';
import { stageRefresh } from '../native.mjs';

// Preserve the ordinary app and its SDK build. Replace only its native job entry
// points and append diagnostic SQL; no HTTP route invokes scheduled work.
export async function stageFaultRefresh(directory, cron = '* * * * *') {
  const { root, project } = await faultProject(directory, cron);
  return stageRefresh(join(root, 'artifact'), project, [cron]);
}
export async function faultProject(directory, cron = '* * * * *') {
  if (!['* * * * *', '*/3 * * * *'].includes(cron)) throw Error('Unsupported fault-profile expression');
  const { root, project } = await privateRefreshProject(directory);
  await cp(new URL('./fault.mjs', import.meta.url), join(project, 'lib/fault.mjs'));
  await cp(new URL('./0002_faults.sql', import.meta.url), join(project, 'db/migrations/0002_faults.sql'));
  for (const job of ['inventory', 'advisory']) await writeFile(join(project, 'crons', `${job}.ts`), `import { defineScheduled } from 'void';\nimport { faultJob } from '../lib/fault.mjs';\nimport { scheduledRefresh } from '../lib/refresh.mjs';\nexport const cron = ${JSON.stringify(cron)};\nexport default defineScheduled((event, env) => faultJob(${JSON.stringify(job)}, event, env, scheduledRefresh));\n`);
  return { root, project };
}
