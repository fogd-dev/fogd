import assert from 'node:assert/strict';
import { prefixFingerprints } from '../../queue-probe/prefix-fingerprints.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';
import { expect } from '../../guestbook-browser.mjs';

export async function fingerprints(probe, prefix) {
  return prefixFingerprints(probe.compose, prefix, probe.daemon);
}
export async function retiredPrefixes(probe, state) {
  const result = {};
  let lastError;
  try {
    await expect.poll(async () => {
      try {
        for (const [name, app] of Object.entries(state.apps)) if (app.retirement) result[name] = { prefix: app.retirement.previous.prefix, objects: await fingerprints(probe, app.retirement.previous.prefix) };
        return true;
      } catch (error) { lastError = error; return false; }
    }, { timeout: 60000 }).toBe(true);
  } catch (error) { throw new Error('Retained namespace could not be read', { cause: lastError || error }); }
  for (const value of Object.values(result)) assert.ok(value.objects.length > 0, 'Retired source prefix must have real retained bytes');
  return result;
}
export async function assertRetained(probe, expected) {
  const actual = {};
  for (const [name, value] of Object.entries(expected)) {
    actual[name] = { prefix: value.prefix, objects: await fingerprints(probe, value.prefix) };
    assert.deepEqual(actual[name], value, 'A retired namespace changed after its stopped archive was restored');
  }
  return actual;
}
export async function controllerFiles(probe) {
  const code = "import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{regularFiles}from'./packages/runtime/src/artifact.mjs';const result={};for(const directory of ['artifacts','secrets'])for(const file of await regularFiles('/data/'+directory)){if(directory==='secrets'&&file==='index.json')continue;result[directory+'/'+file]=createHash('sha256').update(await readFile('/data/'+directory+'/'+file)).digest('hex')}console.log(JSON.stringify(result));";
  return JSON.parse(await volumeHelper(probe.identity.image, probe.config.volumes.controller.name, ['node', '--input-type=module', '-e', code]));
}
export async function assertControllerFiles(probe, expected) {
  const current = await controllerFiles(probe);
  for (const [path, digest] of Object.entries(expected)) assert.equal(current[path], digest, `Retained private recovery material changed: ${path}`);
}
