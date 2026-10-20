import { buildEnvironment } from '../packages/cli/src/build-env.mjs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { run, stackRoot } from '../packages/cli/src/local.mjs';
import { regularFiles } from '../packages/runtime/src/artifact.mjs';
import { stageAssets } from '../packages/runtime/src/assets.mjs';

// Private runtime qualification. The caller explicitly adapts unsupported native
// declarations; this helper never creates an admissible fogd upload.
export async function nativeBuild(directory, project, adapt) {
  const output = resolve(directory); await mkdir(output, { mode: 0o700 });
  await run(process.execPath, [join(stackRoot, 'packages/cli/src/build.mjs'), project], { cwd: project, env: buildEnvironment() });
  const source = JSON.parse(await readFile(join(project, 'dist/ssr/wrangler.json'), 'utf8'));
  const config = adapt(source);
  await cp(join(project, 'dist/ssr'), join(output, 'worker'), { recursive: true });
  await mkdir(join(output, 'migrations'), { mode: 0o700 });
  await cp(join(project, 'db/migrations'), join(output, 'migrations/DB'), { recursive: true });
  if (config.assets) {
    const assets = resolve(project, 'dist/ssr', source.assets.directory);
    await stageAssets(assets, join(output, 'assets'), await regularFiles(assets));
  }
  await writeFile(join(output, 'wrangler.json'), JSON.stringify(config, null, 2));
  return { output, config, source };
}
