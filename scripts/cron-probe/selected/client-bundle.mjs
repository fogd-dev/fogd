import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHostTrial } from './selected-trial.mjs';
import { copyFixture } from './project-copy.mjs';
import { commandJson } from './commands.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { expectRefusal } from './evidence.mjs';
import { scanPublicSurfaces, assertNoSecrets } from './privacy.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { composeArgs } from '../../../packages/cli/src/recovery/docker.mjs';
import { transferFiles, verifyClientFiles } from '../../../packages/cli/src/distribution/bootstrap.mjs';

await selectedHostTrial(process.argv[2], 'Standalone developer client outside the checkout: image-free verified export, scoped TLS submission and status, pending approval boundary, two real cached Void builds, retained D1 records, controller restart and credential isolation. Same local engine; no second-machine claim.', async context => {
  const { source: host, evidence } = context, request = await httpsClient(host);
  await waitFor('developer bundle owner API', async () => (await request('/v1/admin')).status === 200);
  const token = (await host.json(['admin', 'issue-token', 'client-builder', 'baseline'])).token;
  const other = (await host.json(['admin', 'issue-token', 'client-other', 'baseline'])).token;
  const fixture = { tokens: { builder: token, other }, secret: token };
  const bundle = join(host.output, 'developer-bundle');
  evidence.exported = await host.json(['client', 'export', bundle]);
  const inventory = await verifyClientFiles(bundle, evidence.exported.manifestSha256);
  const bytes = await Promise.all((await transferFiles(bundle)).map(path => readFile(join(bundle, path))));
  assertNoSecrets(bytes, [token, other, host.config.services.controller.environment.AWS_ACCESS_KEY_ID, host.config.services.controller.environment.AWS_SECRET_ACCESS_KEY]);
  await readOnly(bundle);
  const home = join(host.output, 'developer-state');
  const env = { PATH: '', HOME: host.output, FOGD_CLIENT_HOME: home, FOGD_SERVER: host.env.FOGD_SERVER,
    FOGD_DEPLOY_TOKEN: token, NODE_EXTRA_CA_CERTS: host.env.NODE_EXTRA_CA_CERTS };
  const command = (args, options = {}) => host.run(process.execPath, [join(bundle, 'fogd.mjs'), ...args], { env, cwd: host.output, ...options });
  const json = async (args, options) => commandJson(await command(args, options));
  evidence.verified = commandJson(await host.run(process.execPath, [join(bundle, 'verify-client.mjs'), bundle, evidence.exported.manifestSha256], { env, cwd: host.output }));
  evidence.help = await command(['--help']);
  const project = await copyFixture(host, 'guestbook', 'developer-guestbook');
  const migration = join(project, 'db/migrations/20261016160656_complete_ser_duncan.sql');
  await writeFile(migration, (await readFile(migration, 'utf8')) + "\nINSERT INTO messages(id,text,created_at) VALUES(1,'client-preserved-row','2026-10-22 12:00:00');\n");
  context.phase = 'standalone-first-deployment';
  const first = await json(['deploy', '--name', 'baseline'], { cwd: project }); evidence.first = first;
  assert.equal(first.status, 'pending');
  const state = (await request('/v1/admin')).json(); assert.equal(state.apps.baseline, undefined);
  evidence.pending = await json(['status', first.id]); assert.equal(evidence.pending.status, 'pending');
  assert.deepEqual((await request('/v1/admin')).json(), state);
  evidence.operatorRefusal = await expectRefusal({ command }, ['admin', 'approve', first.id, first.digest], /supports deploy and status/);
  await host.json(['admin', 'approve', first.id, first.digest]);
  evidence.active = await json(['status', first.id]); assert.equal(evidence.active.status, 'active');
  evidence.initialRows = await rows(request);
  context.phase = 'standalone-application-update';
  await writeFile(join(project, 'routes/api/hello.ts'), "import {defineHandler} from 'void';\nexport const GET=defineHandler(()=>({version:'standalone-client-update'}));\n");
  const second = await json(['deploy', '--name', 'baseline'], { cwd: project }); evidence.second = second;
  assert.notEqual(second.digest, first.digest); assert.equal(second.status, 'pending');
  evidence.beforeApprovalRows = await rows(request); assert.deepEqual(evidence.beforeApprovalRows, evidence.initialRows);
  await host.json(['admin', 'approve', second.id, second.digest]);
  const version = await request('/api/hello', { app: 'baseline' }); assert.equal(version.status, 200); assert.deepEqual(version.json(), { version: 'standalone-client-update' });
  evidence.updatedRows = await rows(request); assert.deepEqual(evidence.updatedRows, evidence.initialRows);
  const canonical = join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json');
  await host.run('docker', [...composeArgs(canonical, host.project), 'restart', 'controller']);
  await waitFor('controller restart serving', async () => { const observed = await rows(request); assert.deepEqual(observed, evidence.initialRows); return true; });
  evidence.restarted = await json(['status', second.id]); assert.equal(evidence.restarted.status, 'active');
  context.phase = 'standalone-credential-isolation';
  evidence.otherCredentialRefusal = await expectRefusal({ command: args => command(args, { env: { ...env, FOGD_DEPLOY_TOKEN: other } }) }, ['status', second.id], /unavailable to this deploy credential/);
  const directories = await readdir(join(home, '.fogd/build-cache/baseline'));
  assert.deepEqual(directories.sort(), [first.localBuildId, second.localBuildId].sort());
  for (const release of [first, second]) {
    const record = JSON.parse(await readFile(join(home, '.fogd/build-cache/baseline', release.localBuildId, 'record.json')));
    assert.equal(record.phase, 'submitted'); assert.equal(record.digest, release.digest); assert.equal(record.submission, release.id);
  }
  evidence.cacheListing = await host.json(['builds', 'list', 'baseline'], { env: { ...host.env, FOGD_HOME: home } });
  assert.deepEqual(evidence.cacheListing.builds.map(build => build.id).sort(), directories.sort());
  await assert.rejects(access(join(bundle, '.fogd')), { code: 'ENOENT' });
  assert.deepEqual(await verifyClientFiles(bundle, evidence.exported.manifestSha256), inventory);
  evidence.privacy = await scanPublicSurfaces(host, request, [first, second], token, [other], evidence);
  evidence.shutdown = await stopSelectedHost(host); host.closed = true; assert.equal(evidence.shutdown.retainedVolumes.length, 8);
  return fixture;
});

async function rows(request) {
  const result = await request('/api/messages', { app: 'baseline' }); assert.equal(result.status, 200);
  const records = result.json(); assert.equal(records.length, 1); assert.equal(records[0].text, 'client-preserved-row'); return records;
}
async function readOnly(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await readOnly(path); else await chmod(path, 0o400);
  }
  await chmod(directory, 0o500);
}
