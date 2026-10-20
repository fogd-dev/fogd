import assert from 'node:assert/strict';
import { join } from 'node:path';
import { nativeBuild } from '../native-build.mjs';
import { stackRoot } from '../../packages/cli/src/local.mjs';
import { translateConfig } from '../../packages/runtime/src/artifact.mjs';

export function stageRefresh(directory, project = join(stackRoot, 'examples/refresh'), crons = ['* * * * *']) {
  return nativeBuild(directory, project, source => {
    assert.deepEqual(source.triggers.crons, crons);
    assert.deepEqual(source.secrets.required, ['REFRESH_TOKEN']);
    return { ...translateConfig({ ...source, triggers: undefined }, 'refresh'), triggers: source.triggers };
  });
}
