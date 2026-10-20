import { cp, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { stackRoot } from '../../../packages/cli/src/local.mjs';
import { stageRefresh } from '../native.mjs';

// Preserve the ordinary app and its SDK build. Replace only its native job entry
// points and append diagnostic SQL; no HTTP route invokes scheduled work.
export async function stageFaultRefresh(directory, cron = '* * * * *') {
  if (!['* * * * *', '*/3 * * * *'].includes(cron)) throw Error('Unsupported fault-profile expression');
  const root = resolve(directory), local = relative(join(stackRoot, '.fogd'), root);
  if (!local || local.startsWith('..') || isAbsolute(local)) throw Error('Place fault evidence inside this checkout’s .fogd directory to use pinned build dependencies');
  await mkdir(root, { mode: 0o700 });
  const project = join(root, 'project'); await mkdir(project, { mode: 0o700 });
  for (const path of ['package.json', 'vite.config.ts', 'void.config.ts', 'fogd.json', 'tsconfig.json', 'env.ts', 'db', 'routes', 'lib']) {
    await cp(join(stackRoot, 'examples/refresh', path), join(project, path), { recursive: true });
  }
  await cp(new URL('./fault.mjs', import.meta.url), join(project, 'lib/fault.mjs'));
  await cp(new URL('./0002_faults.sql', import.meta.url), join(project, 'db/migrations/0002_faults.sql'));
  await mkdir(join(project, 'crons'));
  for (const job of ['inventory', 'advisory']) await writeFile(join(project, 'crons', `${job}.ts`), `import { defineScheduled } from 'void';\nimport { faultJob } from '../lib/fault.mjs';\nimport { scheduledRefresh } from '../lib/refresh.mjs';\nexport const cron = ${JSON.stringify(cron)};\nexport default defineScheduled((event, env) => faultJob(${JSON.stringify(job)}, event, env, scheduledRefresh));\n`);
  return stageRefresh(join(root, 'artifact'), project, [cron]);
}
