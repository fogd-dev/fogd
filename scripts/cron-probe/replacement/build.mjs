import { cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { privateRefreshProject } from '../refresh-project.mjs';
import { stageRefresh } from '../native.mjs';

export async function stageReplacementRefresh(directory, release) {
  if (!['old', 'new', 'final'].includes(release)) throw Error('Unknown qualification release');
  const { root, project } = await privateRefreshProject(directory);
  await cp(new URL('./job.mjs', import.meta.url), join(project, 'lib/replacement.mjs'));
  await cp(new URL('./0002_replacement.sql', import.meta.url), join(project, 'db/migrations/0002_replacement.sql'));
  if (release !== 'old') await writeFile(join(project, 'db/migrations/0003_compatible.sql'), "ALTER TABLE refresh_results ADD COLUMN compatibility_marker TEXT NOT NULL DEFAULT 'compatible';\n");
  for (const job of ['inventory', 'advisory']) await writeFile(join(project, 'crons', `${job}.ts`), `import { defineScheduled } from 'void';\nimport { replacementJob } from '../lib/replacement.mjs';\nimport { beginScheduledRefresh } from '../lib/refresh.mjs';\nexport const cron = '* * * * *';\nexport default defineScheduled((event, env) => replacementJob(${JSON.stringify(release)}, ${JSON.stringify(job)}, event, env, beginScheduledRefresh));\n`);
  return stageRefresh(join(root, 'artifact'), project);
}
