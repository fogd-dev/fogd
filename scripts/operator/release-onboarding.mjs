import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { transferFingerprint } from '../../packages/cli/src/distribution/files.mjs';
import { commandRunner, commandJson } from '../cron-probe/selected/commands.mjs';
import { archiveSources, sourceInventory, sourceState } from '../cron-probe/selected/evidence.mjs';
import { freshReceivedHost } from './release-host.mjs';
import { receivedApplications } from './release-workflow.mjs';
import { stopSelectedHost } from '../cron-probe/selected/shutdown.mjs';
import { cleanupSelectedHost } from '../cron-probe/selected/host.mjs';
import { scanOutputFiles } from '../cron-probe/selected/privacy.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  release: { type: 'string' }, 'expected-manifest': { type: 'string' }, 'expected-bootstrap': { type: 'string' },
} });
assert.equal(positionals.length, 1); assert.ok(values.release && process.env.DOCKER_CONTEXT);
for (const name of ['expected-manifest', 'expected-bootstrap']) assert.match(values[name] || '', /^[a-f0-9]{64}$/);
const output = resolve(positionals[0]), directory = resolve(values.release), hosts = [], evidence = {};
await mkdir(output, { mode: 0o700 });
const save = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const run = commandRunner(output, process.env), provenance = await sourceState(), sources = await sourceInventory();
await archiveSources(output, provenance, sources, new URL(import.meta.url));
let phase = 'verify-release'; const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  assert.equal((await transferFingerprint(join(directory, 'verify-release.mjs'))).sha256, values['expected-bootstrap']);
  evidence.release = JSON.parse(await run(process.execPath, [join(directory, 'verify-release.mjs'), directory, values['expected-manifest']], { env: { PATH: '' }, timeout: 300000 }));
  assert.equal(evidence.release.dockerContacted, false);
  evidence.release.manifestSha256 = values['expected-manifest']; evidence.release.bootstrapSha256 = values['expected-bootstrap'];
  evidence.before = { info: JSON.parse(await run('docker', ['info', '--format', '{{json .}}'])) };
  for (const [name, args] of Object.entries({ images: ['image', 'ls', '-aq'], containers: ['ps', '-aq'], volumes: ['volume', 'ls', '-q'] })) {
    evidence.before[name] = (await run('docker', args)).trim(); assert.equal(evidence.before[name], '', 'Onboarding requires a fresh empty engine');
  }
  phase = 'import-release'; const received = join(output, 'operator');
  evidence.imported = commandJson(await run(process.execPath, [join(directory, 'operator/program/packages/cli/bin/fogd.js'), 'runtime', 'import', join(directory, 'operator'),
    '--runtime', evidence.release.runtime, '--expected-manifest', evidence.release.runtimeManifestSha256, '--output', received], { cwd: directory, timeout: 900000 }));
  assert.equal(evidence.imported.servicesStarted, false);
  for (const args of [['ps', '-aq'], ['volume', 'ls', '-q']]) assert.equal((await run('docker', args)).trim(), '');
  evidence.imagesAfterImport = (await run('docker', ['image', 'ls', '-aq'])).trim().split(/\s+/); assert.equal(new Set(evidence.imagesAfterImport).size, 2);
  phase = 'fresh-enrollment'; const host = await freshReceivedHost(received, join(output, 'installation'), hosts, { runtime: evidence.release.runtime });
  evidence.source = { project: host.project, policy: host.policy, initialServices: host.initialServices, tlsRefusal: host.tlsRefusal };
  const client = { directory: join(directory, 'client'), manifestSha256: evidence.release.clientManifestSha256, bootstrapSha256: values['expected-bootstrap'] };
  const fixture = await receivedApplications(host, evidence, value => { phase = value; }, client);
  phase = 'retained-shutdown'; await host.command(['stop', '--installation', host.project]);
  evidence.shutdown = await stopSelectedHost(host, { alreadyStopped: true }); host.closed = true;
  assert.deepEqual(await sourceState(), provenance); assert.deepEqual(await sourceInventory(), sources);
  const receipt = { scope: 'Versioned release authenticated and imported onto a newly empty Linux arm64 classic-overlay2 engine. Received operator and included client perform fresh HTTPS approval, compatible update, pending isolation and retained restart. Prepared app dependencies; same physical Mac, no public publication.', provenance, sources, evidence };
  receipt.privacy = await scanOutputFiles(hosts, fixture, receipt); await save('result.json', receipt);
  const bytes = await readFile(join(output, 'result.json')); await save('post-write-privacy.json', { sha256: createHash('sha256').update(bytes).digest('hex'), ...await scanOutputFiles(hosts, fixture, receipt, [bytes]) });
  console.log('PASS-versioned-release-empty-engine-onboarding');
} catch (error) { await save('failure.json', { phase, name: error.name, message: error.message, evidence }); throw error; }
finally { clearInterval(heartbeat); for (const host of hosts.filter(host => !host.closed).reverse()) await cleanupSelectedHost(host); }
