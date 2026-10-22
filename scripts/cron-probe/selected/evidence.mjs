import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
export async function sourceInventory() {
  const execute = promisify(execFile), scope = ['packages', 'examples/refresh', 'examples/imports', 'scripts/cron-probe', 'scripts/native-build.mjs', 'compose.yaml', 'pnpm-lock.yaml', 'package.json'];
  const [{ stdout }, { stdout: removed }] = await Promise.all([
    execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...scope], { cwd: repo }),
    execute('git', ['ls-files', '--deleted', '-z', '--', ...scope], { cwd: repo }),
  ]);
  const deleted = new Set(removed.split('\0').filter(Boolean));
  const selected = (await readdir(new URL('./', import.meta.url))).filter(name => name.endsWith('.mjs')).map(name => `scripts/cron-probe/selected/${name}`);
  const paths = [...new Set([...stdout.split('\0').filter(Boolean), ...selected])].filter(name => !deleted.has(name)).sort();
  return Object.fromEntries(await Promise.all(paths.map(async name => [name, createHash('sha256').update(await readFile(join(repo, name))).digest('hex')])));
}

export async function sourceState() {
  const execute = promisify(execFile);
  const head = await execute('git', ['rev-parse', 'HEAD'], { cwd: repo });
  const status = await execute('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo });
  return { head: head.stdout.trim(), status: status.stdout, node: process.version };
}

export async function expectRefusal(host, args, message) {
  return commandRefusal(host.command(args), message);
}

export async function commandRefusal(command, message) {
  let captured;
  await assert.rejects(command, error => { captured = error; return Boolean(error.diagnosticFile); });
  const diagnostic = JSON.parse(await readFile(captured.diagnosticFile, 'utf8'));
  assert.equal(diagnostic.code, 1); assert.equal(diagnostic.signal, null);
  assert.match(diagnostic.stderr, message);
  return { code: diagnostic.code, signal: diagnostic.signal, expectedRefusalMatched: true };
}

export function assertEmptyJobs(observation) {
  assert.equal(observation.status.paused, true); assert.equal(observation.status.nextAlarm, null);
  for (const database of observation.databases) for (const table of ['refresh_occurrences', 'refresh_results']) assert.deepEqual(database.data[table], []);
}

export function assertActive(state, submitted, revision, desired = 'running') {
  const app = state.apps.refresh, request = state.deployments[submitted.id], dispatch = app.dispatch;
  assert.equal(request.status, 'active'); assert.equal(request.secretRevision, revision); assert.equal(request.digest, submitted.digest);
  assert.equal(app.active, submitted.id); assert.equal(app.uncertain, null); assert.equal(app.route, 'active');
  assert.equal(dispatch.hold, null); assert.equal(dispatch.operation, null); assert.equal(dispatch.observed, desired);
  assert.equal(dispatch.desired, desired); assert.equal(dispatch.version, request.version);
}
