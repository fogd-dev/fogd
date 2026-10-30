import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { archiveApprovalFixture, archive } from './fixtures/archive-approval.mjs';
import { archiveRotationReview, stageArchiveRotationSecrets, rotateAppArchiveRecovery } from '../src/app-archive-rotation.mjs';
import { approveAppArchiveRecovery } from '../src/app-archive-approval.mjs';
import { projectAppArchive, projectAppArchiveRestore, validateAppArchives } from '../src/app-archive.mjs';
import { appArchiveRotationCapability, assertArchiveRotationsSettled } from '../src/app-archive-rotation-state.mjs';
import { Controller } from '../src/controller.mjs';
import { adminState } from '../src/admin-view.mjs';
import { saveJson } from '../src/store.mjs';

async function fixture(t, options = {}) {
  const f = await archiveApprovalFixture(t, options);
  Object.assign(f.profile, { schema: 4, controllerArgs: ['packages/platform/src/main-archive.mjs'] });
  f.c = new Controller({ ...f.settings, archiveProfile: f.profile }); await f.c.init();
  const effects = [], native = { version: f.release.version };
  f.c.backend.publish = async (_, path) => {
    const config = JSON.parse(await readFile(join(path, 'wrangler.json')));
    effects.push({ kind: 'publish', vars: config.vars }); native.version = randomUUID();
    return native.version;
  };
  f.c.backend.deployment = async () => ({ version: native.version });
  f.c.backend.ready = async (_, version) => { assert.equal(version, native.version); effects.push({ kind: 'ready' }); };
  f.c.backend.migrate = async () => assert.fail('Rotation never applies SQL');
  const stage = values => stageArchiveRotationSecrets(f.c, f.profile, f.release.app,
    { archive, identity: f.input.identity, snapshot: f.input.snapshot, deployment: f.release.id, digest: f.release.digest, values });
  const optionsIO = { verifyIdentity: async () => { effects.push({ kind: 'identity' }); } };
  const review = () => archiveRotationReview(f.c, f.profile, f.release.app);
  const rotate = input => rotateAppArchiveRecovery(f.c, f.profile, input?.selection || review().selection,
    { actor: { kind: 'basic', name: 'rotation-owner' }, review: input?.review || review().review }, optionsIO);
  return { ...f, effects, native, stage, review, rotate, optionsIO };
}

test('explicit rotation uses the current vault without the old pin, preserves the immutable archive and leaves routing held', async t => {
  const f = await fixture(t), original = structuredClone(f.c.state.appArchives.records[archive]), before = await f.public();
  const staged = await f.stage({ API_KEY: 'private-rotated-fixture' });
  await rm(join(f.c.secrets.dir, f.secret.revision+'.json'));
  const result = await f.rotate();
  assert.equal(result.execution, 'held');
  assert.deepEqual(f.effects.find(e=>e.kind==='publish').vars, { STATIC: 'private-artifact-literal', API_KEY: 'private-rotated-fixture' });
  const state = await f.disk(), record = state.appArchives.records[archive], release = state.deployments[f.release.id];
  assert.equal(release.secretRevision, staged.revision); assert.equal(release.version, f.native.version);
  assert.equal(record.identity, original.identity); assert.deepEqual(record.deployments, original.deployments);
  assert.equal(record.status, 'recovered'); assert.equal(record.restoration.rotation.secretRevision, staged.revision);
  assert.equal(state.decisions.at(-1).secretRevision, staged.revision); assert.equal(state.decisions.at(-1).outcome, 'succeeded');
  assert.equal(state.apps.demo.route, 'paused'); assert.equal(state.apps.demo.archiveRecovery, undefined);
  assert.deepEqual(await f.public(), before); assert.deepEqual(await readdir(f.c.secrets.execution), []);
  validateAppArchives(state, f.profile);
  assert.doesNotThrow(() => assertArchiveRotationsSettled(state));
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('a stale rotation review refuses before native contact or publication', async t => {
  const f = await fixture(t); await f.stage({ API_KEY: 'private-first' }); const before = f.review();
  await f.stage({ API_KEY: 'private-second' });
  await assert.rejects(f.rotate(before), { code: 'APP_ARCHIVE_ROTATION_REFUSED' });
  assert.deepEqual(f.effects, []); assert.equal((await f.disk()).apps.demo.archiveRecovery.status, 'pending');
});

test('successive archive lifecycles retain historical rotations while binding the latest execution', async t => {
  const f = await fixture(t); await f.stage({ API_KEY: 'private-first-cycle' }); await f.rotate();
  const first = await f.disk(), id = randomUUID(), archivedProfile = structuredClone(f.profile);
  const fleet = archivedProfile.fleets.find(value => value.id === first.apps.demo.slot);
  fleet.prefix = 'archive-generations/' + id;
  fleet.nodes = fleet.nodes.map(node => ({ ...node, id: node.host + '-' + id }));
  const archived = projectAppArchive({ state: first, sourceProfile: f.profile, profile: archivedProfile,
    snapshot: 'e'.repeat(64), app: 'demo', digest: f.release.digest, id, at: '2026-10-30T03:00:00.000Z' });
  const restored = projectAppArchiveRestore({ state: archived, sourceProfile: archivedProfile, profile: f.profile,
    snapshot: 'f'.repeat(64), archive: id, expectedIdentity: archived.appArchives.records[id].identity, slot: 'slot-2' });
  validateAppArchives(restored, f.profile);
  const rotation = { secretRevision: randomUUID(), valuesSha256: 'a'.repeat(64), version: randomUUID() };
  const decision = { ...restored.decisions.at(-1), id: randomUUID(), secretRevision: rotation.secretRevision };
  restored.decisions.push(decision);
  Object.assign(restored.deployments[f.release.id], { secretRevision: rotation.secretRevision, version: rotation.version });
  Object.assign(restored.appArchives.records[id], { status: 'recovered' });
  Object.assign(restored.appArchives.records[id].restoration, { rotation, decision: decision.id });
  delete restored.apps.demo.archiveRecovery;
  // Registry insertion order must not choose which historical decision is current.
  restored.appArchives.records = Object.fromEntries(Object.entries(restored.appArchives.records).reverse());
  validateAppArchives(restored, f.profile);
  assert.deepEqual(restored.appArchives.records[archive], first.appArchives.records[archive]);
  restored.deployments[f.release.id].version = first.deployments[f.release.id].version;
  assert.throws(() => validateAppArchives(restored, f.profile), { code: 'APP_ARCHIVE_REFUSED' });
});

test('lost publication leaves a pinned intent; retry publishes only that revision and never reapplies SQL', async t => {
  const f = await fixture(t); const staged = await f.stage({ API_KEY: 'private-rotation-retry' });
  const publish = f.c.backend.publish; let once = true;
  f.c.backend.publish = async (...args) => { const version = await publish(...args); if (once) { once=false; throw Error('private-lost-reply'); } return version; };
  await assert.rejects(f.rotate(), { code: 'APP_ARCHIVE_ROTATION_REFUSED' });
  const state = await f.disk(); assert.equal(state.apps.demo.archiveRecovery.rotation.version, null);
  assert.equal(state.apps.demo.archiveRecovery.rotation.secretRevision, staged.revision);
  assert.equal(state.decisions.at(-1).outcome, 'unconfirmed'); validateAppArchives(state, f.profile);
  assert.throws(() => assertArchiveRotationsSettled(state), /Resolve archive secret rotation/);
  await assert.rejects(f.stage({ API_KEY: 'private-cannot-reselect' }), { code: 'APP_ARCHIVE_ROTATION_REFUSED' });
  await assert.rejects(approveAppArchiveRecovery(f.c,f.profile,f.input,f.context()),{code:'APP_ARCHIVE_APPROVAL_REFUSED'});
  await f.rotate(); assert.equal((await f.disk()).appArchives.records[archive].status,'recovered');
});

test('a recorded publication can complete after observation failure without republishing private configuration', async t => {
  const f = await fixture(t); await f.stage({ API_KEY: 'private-recorded-publication' });
  const ready=f.c.backend.ready;f.c.backend.ready=async()=>{throw Error('native unavailable')};
  await assert.rejects(f.rotate(),{code:'APP_ARCHIVE_ROTATION_REFUSED'});
  const state=await f.disk();assert.equal(state.apps.demo.archiveRecovery.rotation.version,f.native.version);
  f.c.backend.ready=ready;const restarted=new Controller({...f.settings,archiveProfile:f.profile});await restarted.init();
  const review=archiveRotationReview(restarted,f.profile,f.release.app);
  await rotateAppArchiveRecovery(restarted,f.profile,review.selection,{actor:{kind:'basic',name:'rotation-owner'},review:review.review},f.optionsIO);
  assert.equal(f.effects.filter(e=>e.kind==='publish').length,1);
});

test('mutating pinned vault bytes between retries cannot approve an already published private version', async t => {
  const f=await fixture(t),staged=await f.stage({API_KEY:'private-original-selected'});
  f.c.backend.ready=async()=>{throw Error('unavailable')};await assert.rejects(f.rotate(),{code:'APP_ARCHIVE_ROTATION_REFUSED'});
  await writeFile(join(f.c.secrets.dir,staged.revision+'.json'),JSON.stringify({app:'demo',values:{API_KEY:'private-changed'}}));
  const count=f.effects.length;await assert.rejects(f.rotate(),{code:'APP_ARCHIVE_ROTATION_REFUSED'});assert.equal(f.effects.length,count);
});

for(const committed of [false,true])test(`uncertain rotation completion save retains authoritative state: committed=${committed}`,async t=>{
  let armed=false;const f=await fixture(t,{persist:async(path,state)=>{if(armed&&state.decisions?.at(-1)?.outcome==='succeeded'){if(committed)await saveJson(path,state);throw Error('private-store-failure')}await saveJson(path,state)}});
  await f.stage({API_KEY:'private-save-test'});armed=true;
  await assert.rejects(f.rotate(),{code:'CONTROLLER_STORAGE_UNCERTAIN'});
  const state=await f.disk();assert.equal(state.appArchives.records[archive].status,committed?'recovered':'restored');
  assert.equal(Boolean(state.apps.demo.archiveRecovery),!committed);validateAppArchives(state,f.profile);assert.ok((await f.public()).routes.every(r=>r.state==='withheld'));
});

test('invalid input cannot select a cleanup path',async t=>{
  const f=await fixture(t);let cleanups=0;f.c.secrets.cleanup=async()=>{cleanups++};
  await assert.rejects(rotateAppArchiveRecovery(f.c,f.profile,{deployment:'../../retained-data'},{},f.optionsIO),{code:'APP_ARCHIVE_ROTATION_REFUSED'});
  assert.equal(cleanups,0);
});

for (const background of ['queue','cron']) test(`${background} rotation rebinds the paused generation without refreshing expiry or acknowledging recovery`,async t=>{
  const f=await fixture(t,{background,privateBackground:true}),name=f.release.app,record=f.c.state.appArchives.records[archive];
  const family=background==='queue'?{control:'delivery',recovery:'queueRecovery',field:'queueSnapshot'}:{control:'dispatch',recovery:'cronRecovery',field:'cronSnapshot'};
  const surface=background==='queue'?f.c.backend.queues:f.c.backend.crons,versions=[];
  surface.snapshot=async(_,subject,version)=>{versions.push(version);return structuredClone(record.app[family.field].observation)};
  const before=structuredClone(f.c.state.apps[name][family.recovery]);
  const staged=await f.stage({API_KEY:'private-background-rotated'});await f.rotate();
  const state=await f.disk(),app=state.apps[name],receipt=app[family.recovery];
  assert.equal(receipt.status,'pending');assert.equal(receipt.id,before.id);assert.equal(receipt.snapshot,before.snapshot);
  assert.equal(receipt.prepared.version,f.native.version);
  assert.equal(receipt.prepared.at,before.prepared.at);assert.equal(receipt.prepared.completedAt,before.prepared.completedAt);
  assert.equal(receipt.prepared.expiresAt,before.prepared.expiresAt);assert.deepEqual(receipt.prepared.observation,before.prepared.observation);
  assert.deepEqual(receipt.previous,before.previous);assert.equal(app[family.control].desired,'paused');assert.equal(app[family.control].hold,null);
  assert.equal(app[family.control].version,f.native.version);assert.equal(app.route,'paused');
  if(background==='cron')assert.equal(receipt.prepared.secretRevision,staged.revision);
  assert.ok(versions.includes(f.native.version));validateAppArchives(state,f.profile);
  const restarted=new Controller({...f.settings,archiveProfile:f.profile});await restarted.init();
  assert.equal(restarted.state.apps[name][family.recovery].status,'pending');
});

test('malformed or unmarked rotation metadata refuses before runtime access',async t=>{
  const f=await fixture(t);await f.stage({API_KEY:'private-malformed'});f.c.backend.ready=async()=>{throw Error('unavailable')};
  await assert.rejects(f.rotate(),{code:'APP_ARCHIVE_ROTATION_REFUSED'});const original=await f.disk();
  for(const change of [state=>{state.requirements=state.requirements.filter(c=>c!==appArchiveRotationCapability)},state=>{state.apps.demo.archiveRecovery.rotation=null},state=>{state.apps.demo.archiveRecovery.rotation.secretRevision=f.secret.revision}]){
    const state=structuredClone(original);change(state);assert.throws(()=>validateAppArchives(state,f.profile),{code:'APP_ARCHIVE_REFUSED'});
  }
});

for(const committed of [false,true])test(`lost journal save stops publication and leaves a restartable gate: committed=${committed}`,async t=>{
  let armed=false;const f=await fixture(t,{persist:async(path,state)=>{if(armed&&state.apps?.demo?.archiveRecovery?.rotation&&state.decisions?.at(-1)?.outcome==='started'){if(committed)await saveJson(path,state);throw Error('private-journal-write')}await saveJson(path,state)}});
  await f.stage({API_KEY:'private-journal-pin'});armed=true;await assert.rejects(f.rotate(),{code:'CONTROLLER_STORAGE_UNCERTAIN'});
  assert.equal(f.effects.filter(e=>e.kind==='publish').length,0);const state=await f.disk();validateAppArchives(state,f.profile);
  assert.equal(Boolean(state.apps.demo.archiveRecovery.rotation),committed);assert.equal(state.apps.demo.route,'paused');
});

test('pending publication fingerprints and private versions do not appear in owner inspection or rotation review',async t=>{
  const f=await fixture(t);await f.stage({API_KEY:'private-inspection-value'});f.c.backend.ready=async()=>{throw Error('unavailable')};
  await assert.rejects(f.rotate(),{code:'APP_ARCHIVE_ROTATION_REFUSED'});const journal=(await f.disk()).apps.demo.archiveRecovery.rotation;
  const visible=JSON.stringify({admin:adminState(f.c),review:f.review()});
  assert.ok(!visible.includes(journal.version));assert.ok(!visible.includes(journal.valuesSha256));assert.ok(!visible.includes('private-inspection-value'));
  assert.equal(adminState(f.c).apps.demo.archiveRecovery.rotation.state,'pending');
});
