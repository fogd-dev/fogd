import assert from 'node:assert/strict';
import { controllerState } from './observations.mjs';
import { scopedClient } from './https.mjs';
import { expectRefusal } from './evidence.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';

export async function retiredAuthorityRefusals(host, request, retired, oldToken, replacement) {
  assert.notEqual(retired.app, replacement.app);
  const privateFiles = await authorityFiles(host);
  const before = await controllerState(host), app = before.apps[retired.app];
  assert.equal(app.route, 'retired'); assert.equal(app.slot, null); assert.equal(app.active, retired.id);
  assert.equal(before.deployments[retired.id].digest, retired.digest);
  assert.equal(before.deployments[replacement.id].app, replacement.app);
  const artifact = await request(`/v1/deployments/${replacement.id}/artifact`), original = await request(`/v1/deployments/${retired.id}/artifact`);
  assert.equal(artifact.status, 200); assert.equal(original.status, 200);
  assert.equal(artifact.json().digest, replacement.digest); assert.equal(original.json().digest, retired.digest);
  const scoped = await scopedClient(host, oldToken);
  const outside = await scoped('/v1/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: artifact.text });
  assert.equal(outside.status, 400); assert.match(outside.json().error, /outside its app scope/);
  const oldName = await scoped('/v1/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: original.text });
  assert.equal(oldName.status, 400); assert.match(oldName.json().error, /permanently retired/);
  const retiredCredential = await expectRefusal(host, ['admin', 'issue-token', `retired-authority-${retired.app}`, retired.app], /permanently retired/);
  const retiredApproval = await expectRefusal(host, ['admin', 'approve', retired.id, retired.digest, ...(retired.secretRevision ? [retired.secretRevision] : [])], /permanently retired/);
  assert.deepEqual(await controllerState(host), before);
  assert.deepEqual(await authorityFiles(host), privateFiles);
  return { oldScope: outside.json(), retiredName: oldName.json(), retiredCredential, retiredApproval, privateFilesUnchanged: privateFiles };
}

async function authorityFiles(host) {
  const code = "import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';const result={};for(const file of ['state.json','credentials.json','secrets/index.json'])result[file]=createHash('sha256').update(await readFile('/data/'+file)).digest('hex');console.log(JSON.stringify(result));";
  return JSON.parse(await volumeHelper(host.entry.image, host.config.volumes.controller.name, ['node', '--input-type=module', '-e', code]));
}
