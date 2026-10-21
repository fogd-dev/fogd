import assert from 'node:assert/strict';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';
import { sealedRetirementInstall } from './sealed-client.mjs';

export async function targetOwnershipCheck(source) {
  const project = `${source.rootProject}-collision`, name = `${project}-sentinel`, volume = `${project}_controller`, directory = join(source.rootDirectory, 'collision-target');
  await assert.rejects(execute('docker', ['container', 'inspect', name]));
  await assert.rejects(execute('docker', ['volume', 'inspect', volume]));
  const label = `com.docker.compose.project=${project}`;
  await execute('docker', ['volume', 'create', '--label', label, volume]);
  const content = 'qualification-target-ownership-sentinel';
  await volumeHelper(source.identity.image, volume, ['/usr/local/bin/node', '--input-type=module', '-e', `import{writeFile}from'node:fs/promises';await writeFile('/data/sentinel',${JSON.stringify(content)});`], { readonly: false });
  let owned = false;
  try {
    const id = (await execute('docker', ['create', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--label', label, '--label', 'com.docker.compose.service=controller', '--mount', `type=volume,source=${volume},target=/data,readonly`, '--entrypoint', '/usr/bin/true', source.identity.image])).trim(); owned = true;
    await assert.rejects(sealedRetirementInstall(source, { kind: 'restore', bundle: '/unused', project, directory }), /cleanup ownership was not acquired/);
    const [container] = JSON.parse(await execute('docker', ['inspect', name])); assert.equal(container.Id, id);
    assert.equal((await volumeHelper(source.identity.image, volume, ['cat', '/data/sentinel'])).trim(), content);
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    await execute('docker', ['rm', name]); owned = false;
    await assert.rejects(sealedRetirementInstall(source, { kind: 'restore', bundle: '/unused', project, directory }), /Target already owns resources/);
    assert.equal((await volumeHelper(source.identity.image, volume, ['cat', '/data/sentinel'])).trim(), content);
    await assert.rejects(lstat(directory), { code: 'ENOENT' });
    return { case: 'preexisting-target-ownership', refused: true, existingContainerAndDataPreserved: true, volumeOnlyRefused: true, retainedVolume: volume };
  } finally { if (owned) await execute('docker', ['rm', name]); }
}
