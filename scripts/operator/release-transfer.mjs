import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { programInputs, programInventory, copyProgram } from '../../packages/cli/src/distribution/program.mjs';
import { commandRunner, commandJson } from '../cron-probe/selected/commands.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
export function releaseCatalog(original, runtime, released) {
  const catalog = JSON.parse(original), family = catalog.find(value => value.id === runtime);
  assert.ok(family, 'Unknown release runtime family');
  assert.equal(family.admission, released ? 'qualified' : 'candidate');
  family.admission = 'qualified';
  return released ? original : Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
}

export async function releaseTransfer(output, sourceContext, { released = false, runtime = 'celld-durable-v5-linux-arm64' } = {}) {
  const proposal = join(output, released ? 'release-source' : 'proposal'), transfer = join(output, 'transfer'), received = join(output, 'operator');
  await mkdir(proposal, { mode: 0o700 });
  const inputs = await programInputs(repo), inventory = await programInventory(inputs);
  await copyProgram(inputs, proposal, inventory);
  const catalogPath = 'packages/cli/src/runtime/catalog.json', original = await readFile(join(proposal, catalogPath));
  const proposed = releaseCatalog(original, runtime, released);
  if (!released) await writeFile(join(proposal, catalogPath), proposed, { mode: 0o600 });
  const delta = { path: catalogPath, family: runtime, before: hash(original), after: hash(proposed), change: released ? 'actual qualified catalog copied without modification' : 'candidate to qualified in a private rehearsal copy only' };
  await writeFile(join(output, 'proposal-inventory.json'), JSON.stringify({ inventory, delta }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const cli = program => join(program, 'packages/cli/bin/fogd.js');
  const sourceEnv = { ...process.env, DOCKER_CONTEXT: sourceContext }, sourceRun = commandRunner(output, sourceEnv);
  const exported = commandJson(await sourceRun(process.execPath, [cli(proposal), 'runtime', 'export', transfer, '--runtime', runtime], { cwd: proposal, timeout: 900000 }));
  const targetRun = commandRunner(output, process.env);
  const before = { containers: await targetRun('docker', ['ps', '-aq']), volumes: await targetRun('docker', ['volume', 'ls', '-q']) };
  assert.equal(hash(await readFile(join(transfer, 'verify-transfer.mjs'))), exported.bootstrapSha256);
  const checksum = await targetRun('sha256sum', [join(transfer, 'verify-transfer.mjs')]); assert.equal(checksum.split(/\s+/)[0], exported.bootstrapSha256);
  const verified = await targetRun(process.execPath, [join(transfer, 'verify-transfer.mjs'), transfer, exported.manifestSha256], { timeout: 300000 });
  const imported = commandJson(await targetRun(process.execPath, [cli(join(transfer, 'program')), 'runtime', 'import', transfer, '--runtime', runtime, '--expected-manifest', exported.manifestSha256, '--output', received], { cwd: join(transfer, 'program'), timeout: 900000 }));
  assert.equal(imported.servicesStarted, false);
  assert.equal(await targetRun('docker', ['ps', '-aq']), before.containers); assert.equal(await targetRun('docker', ['volume', 'ls', '-q']), before.volumes);
  return { proposal, transfer, received, family: runtime, delta, exported, imported, verified, importContainerAndVolumeInventoryUnchanged: true };
}

export async function verifyReceivedProgram(transfer) {
  const manifest = JSON.parse(await readFile(join(transfer.transfer, 'manifest.json'))); let count = 0;
  for (const [path, expected] of Object.entries(manifest.files).filter(([path]) => path.startsWith('program/'))) {
    const bytes = await readFile(join(transfer.received, path.slice(8))); assert.equal(bytes.length, expected.bytes); assert.equal(hash(bytes), expected.sha256); count++;
  }
  return { files: count, unchanged: true };
}
