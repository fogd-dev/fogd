import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context } from './queue-probe/context.mjs';
import { stackRoot } from '../packages/cli/src/local.mjs';

const [slot, output] = process.argv.slice(2);
const probe = await context(slot, output);
const nonce = randomUUID(), prefix = `qualification/claims/${nonce}`;
assert.ok(probe.slots.every(s => s.prefix !== prefix && !s.prefix.startsWith(prefix + '/') && !prefix.startsWith(s.prefix + '/')), 'Probe namespace must not overlap an app fleet');
const root = (await probe.node('console.log(process.cwd())')).trim();
const target = join(root, 'packages/platform', `.claim-probe-${nonce}`);
await probe.compose(['exec', '-T', 'controller', 'mkdir', '-p', target]);
const hashes = {};
for (const name of ['backend.mjs', 'queue-runtime.mjs']) {
  const source = join(stackRoot, 'packages/platform/src', name);
  hashes[name] = createHash('sha256').update(await readFile(source)).digest('hex');
  await probe.compose(['cp', source, `controller:${target}/${name}`]);
}
const result = JSON.parse(await probe.node(`
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(${JSON.stringify(join(target, 'backend.mjs'))});
const {PutObjectCommand}=require('@aws-sdk/client-s3');
const {Backend}=await import(${JSON.stringify(join(target, 'backend.mjs'))});
const backend=new Backend(), slot={prefix:${JSON.stringify(prefix + '/owned')}};
await backend.assertUnclaimed(slot);
await backend.claim(slot,'claim-fixture',{unpublished:true});
await assert.rejects(backend.assertUnclaimed(slot),/ownership exists/);
const owner=await backend.owner(slot);
await assert.rejects(backend.s3.send(new PutObjectCommand({Bucket:process.env.FOGD_BUCKET,Key:slot.prefix+'/fogd-owner.json',Body:JSON.stringify({app:'foreign'}),IfNoneMatch:'*'})),e=>e.$metadata?.httpStatusCode===412);
await backend.claim(slot,'claim-fixture',{unpublished:true});
assert.deepEqual(await backend.owner(slot),owner);
await assert.rejects(backend.claim(slot,'foreign',{unpublished:true}),/owner mismatch/);
const publish=selected=>backend.s3.send(new PutObjectCommand({Bucket:process.env.FOGD_BUCKET,Key:selected.prefix+'/deploy/probe',Body:'qualification marker'}));
await publish(slot);
await assert.rejects(backend.claim(slot,'claim-fixture',{unpublished:true}),/contains a deployment/);
await backend.claim(slot,'claim-fixture');
const unowned={prefix:${JSON.stringify(prefix + '/unowned')}};
await publish(unowned);
await assert.rejects(backend.claim(unowned,'claim-fixture',{unpublished:true}),/contains a deployment/);
assert.equal(await backend.owner(unowned),null);
await assert.rejects(backend.assertUnclaimed(unowned),/deployment objects/);
assert.deepEqual(await backend.owner(slot),owner);
console.log(JSON.stringify({prefix:${JSON.stringify(prefix)},ownerStable:true,foreignRejected:true,publishedRejected:true,unownedPublishedRejected:true,releaseGuard:true,conditionalCreateRejected:true}));
`));
await probe.save('bucket-claim', { ...result, implementation: hashes, scope: 'Current backend source staged in an isolated controller directory; real MinIO requests, no app deployment' });
console.log('PASS: MinIO ownership claims are idempotent and reject foreign owners and unexpected deployment objects');
