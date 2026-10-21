import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';

export async function compareSourceVolumes(probe, bundle) {
  for (const [name, volume] of Object.entries(probe.config.volumes)) {
    const image = probe.config.services.controller.image, archive = join(bundle, `${name}.tar`);
    await volumeHelper(image, volume.name, ['tar', '--numeric-owner', '-C', '/data', '--compare', '-pf', '-'], { input: archive });
    const listing = await execute('tar', ['-tf', archive]);
    const expected = listing.trim().split('\n').map(path => path.replace(/^\.\//, '').replace(/\/$/, '') || '.').sort();
    const observed = JSON.parse(await volumeHelper(image, volume.name, ['node', '--input-type=module', '-e', "import{readdir}from'node:fs/promises';const names=[];async function visit(path,relative){names.push(relative||'.');for(const entry of await readdir(path,{withFileTypes:true})){const next=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())await visit(path+'/'+entry.name,next);else names.push(next)}}await visit('/data','');console.log(JSON.stringify(names.sort()));"]));
    assert.deepEqual(observed, expected, `${name}: source files were added or removed after snapshot`);
  }
  return { volumes: Object.keys(probe.config.volumes), archivedEntriesCompared: true, completeNamesCompared: true };
}
