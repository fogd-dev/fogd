import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inventory } from '../../../packages/cli/src/recovery/inventory.mjs';
import { verifyIdentityProof, storageOrigin } from '../../../packages/platform/src/runtime-identity-proof.mjs';
import { observerCommand } from './observer-command.mjs';
import { expect } from '../../guestbook-browser.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function observeSealedRuntime(probe, programs, name = 'sealed-runtime', cold = false) {
  const command = observerCommand(probe, cold);
  const listed = JSON.parse(await command([ '/usr/local/bin/node', '--input-type=module', '-e', "import{regularFiles}from'/app/packages/runtime/src/artifact.mjs';console.log(JSON.stringify((await regularFiles('/app/qualification')).map(file=>'/app/qualification/'+file)));"]));
  assert.deepEqual(listed.sort(), Object.keys(programs).sort(), 'Unexpected qualification programs in the image');
  const output = await command(['/usr/bin/sha256sum', ...Object.keys(programs)]);
  const actual = Object.fromEntries(output.trim().split('\n').map(line => { const [digest, path] = line.trim().split(/\s+/); return [path, digest]; }));
  assert.deepEqual(actual, programs, 'Immutable qualification program bytes differ');
  const images = await inventory(probe.config);
  for (const [name, image] of Object.entries(images)) assert.equal(image, name === 'minio' ? probe.runtimeProfile.storageImage : probe.runtimeProfile.image);
  const nodes = probe.runtimeProfile.fleets.flatMap(fleet => fleet.nodes.map(node => ({ ...node, prefix: fleet.prefix })));
  const code = `import{randomBytes}from'node:crypto';const nodes=${JSON.stringify(nodes)};console.log(JSON.stringify(await Promise.all(nodes.map(async node=>{const challenge=randomBytes(32).toString('hex');const response=await fetch('http://'+node.host+':8082/runtime/identity?challenge='+challenge,{signal:AbortSignal.timeout(3000)});if(!response.ok)throw Error('Identity unavailable');return {host:node.host,challenge,proof:await response.json()};}))));`;
  let identities;
  await expect.poll(async () => {
    try { identities = JSON.parse(await command(['/usr/local/bin/node', '--input-type=module', '-e', code], true)); return identities.length; }
    catch { return 0; }
  }, { timeout: 120000 }).toBe(nodes.length);
  for (const value of identities) {
    const node = nodes.find(node => node.host === value.host), identity = verifyIdentityProof(value.proof, value.challenge);
    const namespace = `s3://${probe.runtimeProfile.bucket}/${node.prefix}`;
    assert.deepEqual(identity, { schema: 2, binarySha256: probe.runtimeProfile.binarySha256, nodeSha256: hash(node.id),
      namespaceSha256: hash(namespace), storageSha256: hash(JSON.stringify([namespace, storageOrigin(probe.runtimeProfile.storage.endpoint), probe.runtimeProfile.storage.region])),
      processKeySha256: identity.processKeySha256 });
  }
  const result = { images, programs: actual, identities, sealedInventoryVerified: true };
  await probe.save(name, result); return result;
}
