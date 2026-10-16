import { resolve, dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { stageArtifact } from '../packages/runtime/src/artifact.mjs';
const [project, app, output = '.fogd/artifact'] = process.argv.slice(2);
if (!project || !app) throw new Error('Usage: node scripts/stage.mjs <project> <app> [output]');
await mkdir(dirname(resolve(output)), { recursive: true });
console.log(await stageArtifact({ projectDir: resolve(project), app, outputDir: resolve(output) }));
