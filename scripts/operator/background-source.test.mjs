import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backgroundRecoverySource } from './background-source.mjs';

async function fixture(t, audited) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-background-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = audited ? join(root, 'host-input') : root;
  if (audited) await mkdir(host);
  await writeFile(join(host, 'inputs.json'), JSON.stringify({ project: 'owned-fixture' }));
  const lifecycle = { approvals: { approvals: { refresh: { app: 'refresh', id: 'before-update' }, imports: { app: 'imports', id: 'queued' } } }, update: { active: { app: 'refresh', id: 'after-update' } } };
  const record = { evidence: { snapshot: { bundle: join(root, 'stopped-snapshot') }, ...lifecycle } };
  if (audited) Object.assign(record, { kind: 'audited-native-background-snapshot', passed: true, project: 'owned-fixture', sourceRoot: host, evidence: { snapshot: record.evidence.snapshot, completedLifecycle: lifecycle } });
  const save = () => writeFile(join(root, 'result.json'), JSON.stringify(record));
  await save();
  return { root, host, record, save };
}

for (const audited of [false, true]) test(`recovery selects the updated approval and actual host (${audited ? 'audited snapshot' : 'completed lifecycle'})`, async t => {
  const f = await fixture(t, audited), selected = await backgroundRecoverySource(f.root);
  assert.equal(selected.sourceRoot, f.host);
  assert.equal(selected.bundle, join(f.root, 'stopped-snapshot'));
  assert.equal(selected.approvals.refresh.id, 'after-update');
  assert.equal(selected.approvals.imports.id, 'queued');
});

for (const [name, mutate] of [
  ['failed audit', r => { r.passed = false; }],
  ['another host', r => { r.project = 'another-fixture'; }],
  ['another snapshot', r => { r.evidence.snapshot.bundle = '/unselected/snapshot'; }],
  ['another application', r => { r.evidence.completedLifecycle.update.active.app = 'other'; }],
  ['unknown receipt', r => { r.kind = 'unknown-receipt'; }],
]) test(`inconsistent audited input refuses: ${name}`, async t => {
  const f = await fixture(t, true); mutate(f.record); await f.save();
  await assert.rejects(backgroundRecoverySource(f.root));
});
