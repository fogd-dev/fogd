import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectBuiltProject } from '../src/doctor/application.mjs';
import { formatReport } from '../src/doctor/report.mjs';
import { regularFiles } from '@fogd/runtime/artifact';
import { MAX_UPLOAD } from '@fogd/runtime/manifest';

async function fixture(t, extra = {}) {
  const project = await mkdtemp(join(tmpdir(), 'fogd-doctor-project-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  for (const path of ['dist/ssr', 'dist/client', 'db/migrations']) await mkdir(join(project, path), { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'demo', type: 'module' }));
  await writeFile(join(project, 'vite.config.mjs'), "throw new Error('must-never-execute-build-plugin');");
  await writeFile(join(project, 'dist/ssr/index.js'), "throw new Error('private-worker-content');");
  await writeFile(join(project, 'dist/client/index.html'), 'private-asset-content');
  await writeFile(join(project, 'db/migrations/0001_create.sql'), 'CREATE TABLE private_table (id INTEGER PRIMARY KEY);');
  await writeFile(join(project, 'db/migrations/seed.sql'), 'private-seed-content');
  await writeFile(join(project, 'dist/ssr/wrangler.json'), JSON.stringify({ main: 'index.js', vars: { MESSAGE: 'private-variable-value' },
    secrets: { required: ['API_KEY'] }, assets: { directory: '../client' }, d1_databases: [{ binding: 'DB' }], ...extra }));
  return project;
}
const buildStatus = report => report.findings.find(item => item.id === 'build-output')?.status;
async function snapshot(project) {
  return Object.fromEntries(await Promise.all((await regularFiles(project)).map(async path => [path, (await readFile(join(project, path))).toString('base64')])));
}

test('existing-build diagnosis validates artifact bytes without executing or changing project files', async t => {
  const project = await fixture(t), before = await snapshot(project), report = await inspectBuiltProject(project, 'demo');
  assert.equal(report.scope, 'application-build'); assert.equal(report.readOnly, true); assert.equal(report.capacityReservation, 'none');
  assert.equal(report.status, 'unverified'); assert.equal(buildStatus(report), 'supported');
  assert.equal(report.declarations.d1, 1); assert.equal(report.declarations.assets, true); assert.equal(report.declarations.requiredSecrets, 1);
  assert.equal(report.artifact.migrations, 1); assert.ok(report.artifact.bytes > 0);
  assert.deepEqual(await snapshot(project), before);
  assert.ok(!JSON.stringify(report).includes('private-')); assert.ok(!formatReport(report).includes('private-'));
  assert.ok(formatReport(report).includes(report.artifact.digest));
  await writeFile(join(project, 'dist/ssr/index.js'), 'export default {fetch(){return new Response("changed")}}');
  const changed = await inspectBuiltProject(project, 'demo'); assert.notEqual(changed.artifact.digest, report.artifact.digest);
});

test('existing-build diagnosis honors the same project paths as deployment', async t => {
  const project = await fixture(t);
  await rename(join(project, 'dist'), join(project, 'generated')); await rename(join(project, 'db/migrations'), join(project, 'sql'));
  await writeFile(join(project, 'fogd.json'), JSON.stringify({ buildOutput: 'generated/ssr', migrationsDir: 'sql' }));
  const report = await inspectBuiltProject(project, 'demo'); assert.equal(buildStatus(report), 'supported'); assert.equal(report.artifact.migrations, 1);
});

for (const [name, change, status] of [
  ['multiple worker modules', project => writeFile(join(project, 'dist/ssr/private-extra.js'), 'export const x=1;'), 'unsupported'],
  ['linked worker input', project => symlink(join(project, 'dist/ssr/index.js'), join(project, 'dist/ssr/private-link.js')), 'unsupported'],
  ['linked asset input', project => symlink(join(project, 'dist/client/index.html'), join(project, 'dist/client/private-link.html')), 'unsupported'],
  ['duplicate migration prefixes', project => writeFile(join(project, 'db/migrations/0001_private.sql'), 'CREATE TABLE private_second (id INTEGER);'), 'unsupported'],
  ['missing migration directory', project => rm(join(project, 'db/migrations'), { recursive: true }), 'unverified'],
]) test(`existing-build diagnosis reports ${name} without private details`, async t => {
  const project = await fixture(t); await change(project);
  const report = await inspectBuiltProject(project, 'demo'); assert.equal(buildStatus(report), status); assert.equal(report.status, status);
  assert.equal(report.artifact, undefined); assert.ok(!JSON.stringify(report).includes('private-'));
});

test('missing generated configuration does not query a controller or execute build configuration', async t => {
  const project = await fixture(t); await rm(join(project, 'dist/ssr/wrangler.json'));
  const report = await inspectBuiltProject(project, 'demo', () => assert.fail('no capability request for unreadable build input'));
  assert.equal(report.status, 'unverified'); assert.equal(report.artifact, undefined);
});

test('existing cron build checks target admission without granting offline execution', async t => {
  const project = await fixture(t, { triggers: { crons: ['* * * * *'] } });
  const offline = await inspectBuiltProject(project, 'demo'); assert.equal(buildStatus(offline), 'supported');
  assert.equal(offline.findings.find(item => item.id === 'cron-admission').status, 'unverified');
  const refused = await inspectBuiltProject(project, 'demo', async () => ({ cronApps: false }));
  assert.equal(refused.status, 'unsupported'); assert.equal(refused.artifact, undefined);
});

test('existing-build diagnosis refuses payload bytes above the authoritative receiver limit', async t => {
  const project = await fixture(t);
  await truncate(join(project, 'dist/client/index.html'), MAX_UPLOAD + 1);
  const report = await inspectBuiltProject(project, 'demo');
  assert.equal(buildStatus(report), 'unsupported'); assert.equal(report.artifact, undefined);
});
