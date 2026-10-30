import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { preparePreviewInputPackage, previewInputGroups } from '../src/preview/input-package.mjs';
import { writePreviewInputPackage } from '../src/preview/input-installer.mjs';
import { previewInputFixture } from './fixtures/preview-input-package.mjs';
import { readPreviewControl } from '../src/preview/control-input.mjs';
import { readPreviewService } from '../src/preview/service-input.mjs';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';

const refused = { code: 'PREVIEW_EXECUTION_REFUSED' };
test('input snapshot seals exact artifact, secrets, role TLS and independent authority without executing app code', async t => {
  const f = await previewInputFixture(t), snapshot = await preparePreviewInputPackage(f.authority, f.bundle);
  const root = join(f.root,'volumes');await mkdir(root);
  for (const name of previewInputGroups) await mkdir(join(root,name));
  await writePreviewInputPackage(root,snapshot);
  const control = await readPreviewControl({ trustDirectory:join(root,'controller-trust'),inputDirectory:join(root,'controller-input'),env:{FOGD_PREVIEW_ID:f.plan.request.preparation.id.replaceAll('-',''),FOGD_PREVIEW_STORAGE_PASSWORD:f.options.secretValues.storagePassword,FOGD_PREVIEW_GATEWAY_TOKEN:f.options.secretValues.gatewayToken,FOGD_PREVIEW_EXPIRES_AT:f.envelope.grant.expiresAt} });
  assert.equal(control.artifact.digest,f.bundle.artifact.digest);
  for (const role of ['gateway','ingress']) assert.equal((await readPreviewService(role,{trustDirectory:join(root,role+'-trust'),inputDirectory:join(root,role+'-input'),expiresAt:f.envelope.grant.expiresAt})).grant.preview,f.plan.request.preparation.id);
  assert.equal((await stat(join(root,'controller-input','artifact.json'))).mode&0o777,0o600);
  assert.equal((await stat(join(root,'controller-input'))).mode&0o777,0o700);
  assert.ok(!snapshot.bytes.includes(f.options.secretValues.storagePassword));
  assert.ok(!JSON.stringify(snapshot.files['ingress-input']).includes(f.options.secretValues.gatewayToken));
  const before=await readFile(join(root,'controller-input','artifact.json'));
  await assert.rejects(writePreviewInputPackage(root,snapshot));assert.deepEqual(await readFile(join(root,'controller-input','artifact.json')),before);
});
for (const [name,change] of Object.entries({
  artifact:f=>{f.bundle.artifact.files[0].data=Buffer.from('changed').toString('base64')},
  secrets:f=>{f.bundle.secrets.SOURCE_TOKEN='never-copy'},
  gatewayToken:f=>{f.bundle.gateway.gatewayToken='e'.repeat(64)},
  accessKey:f=>{f.bundle.ingress.accessKey='e'.repeat(64)},
  upstreamTrust:f=>{f.bundle.ingress.upstreamCA=f.bundle.ingress.tls.cert},
  tlsKey:f=>{f.bundle.gateway.tls.key=f.bundle.ingress.tls.key},
  extraConfig:f=>{f.bundle.gateway.upstream='https://production.test'},
  authority:f=>{f.authority.publicKey=f.authority.publicKey.replace('PUBLIC KEY','PRIVATE KEY')},
  target:f=>{f.authority.target.origin='https://production.test'},
})) test(`input snapshot refuses substituted ${name}`,async t=>{const f=await previewInputFixture(t);change(f);await assert.rejects(preparePreviewInputPackage(f.authority,f.bundle),refused)});

test('input bytes are snapshotted before asynchronous validation and mutable caller edits',async t=>{
 const f=await previewInputFixture(t),expected=hash(jsonBytes(f.bundle)),pending=preparePreviewInputPackage(f.authority,f.bundle);
 f.bundle.gateway.gatewayToken='e'.repeat(64);f.authority.fingerprints.artifact='0'.repeat(64);
 const snapshot=await pending;assert.equal(snapshot.sha256,expected);
});
test('expired grant and noncanonical bytes refuse before any target writes',async t=>{
 const f=await previewInputFixture(t);await assert.rejects(preparePreviewInputPackage(f.authority,Buffer.from(JSON.stringify(f.bundle))),refused);
 t.mock.method(Date,'now',()=>Date.parse(f.envelope.grant.expiresAt));await assert.rejects(preparePreviewInputPackage(f.authority,f.bundle),refused);
});
test('a retained partial file in any role prevents writes to every role',async t=>{
 const f=await previewInputFixture(t),snapshot=await preparePreviewInputPackage(f.authority,f.bundle),root=join(f.root,'volumes');await mkdir(root);
 for(const name of previewInputGroups)await mkdir(join(root,name));
 await writeFile(join(root,'ingress-input','partial'),'retained');await assert.rejects(writePreviewInputPackage(root,snapshot));
 for(const name of previewInputGroups.slice(0,-1))assert.deepEqual(await readdir(join(root,name)),[]);
 assert.equal(await readFile(join(root,'ingress-input','partial'),'utf8'),'retained');
});
