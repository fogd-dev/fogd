import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { context } from './queue-probe/context.mjs';
import { backup } from '../packages/cli/src/recovery/backup.mjs';
import { volumeHelper } from '../packages/cli/src/recovery/volumes.mjs';
import { projectContainers } from '../packages/cli/src/recovery/docker.mjs';

// Synthetic permanent-capability fixture; no queue deployment or restore claim.
const probe = await context('slot-1', process.argv[2]);
assert.equal(probe.config.services.controller.environment.FOGD_DATA_DIR, undefined);
const image = probe.config.services.controller.image, volume = probe.config.volumes.controller.name;
const saved = `/data/queue-recovery-guard-${randomUUID()}.json`;
const helper = code => volumeHelper(image, volume, ['node', '--input-type=module', '-e', code], { readonly: false });
const states = async () => (await projectContainers(probe.config.name)).map(c => ({ id: c.Id, running: c.State.Running, startedAt: c.State.StartedAt })).sort((a, b) => a.id.localeCompare(b.id));
assert.ok((await projectContainers(probe.config.name)).find(c => c.Config.Labels['com.docker.compose.service'] === 'controller')?.State.Running);
await probe.compose(['stop', 'controller']);
try {
  await helper(`import {readFile,writeFile} from 'node:fs/promises'; import {saveJson} from './packages/platform/src/store.mjs'; const original=await readFile('/data/state.json'); await writeFile(${JSON.stringify(saved)},original,{flag:'wx',mode:0o600}); const state=JSON.parse(original); state.requirements=[...new Set([...(state.requirements||[]),'fogd-queue-activation-v1'])]; await saveJson('/data/state.json',state);`);
  const before = await states(), output = join(probe.output, 'refused-snapshot');
  await assert.rejects(backup(output), /Queued installation recovery/);
  assert.deepEqual(await states(), before, 'Backup preflight must not stop or restart containers');
  await assert.rejects(access(output), /ENOENT/);
  await probe.save('guard', { project: probe.config.name, syntheticQueueCapability: true, preflightRefused: true, outputCreated: false, containerStatesUnchanged: true });
} finally {
  await helper(`import {readFile,unlink} from 'node:fs/promises'; import {saveJson} from './packages/platform/src/store.mjs'; await saveJson('/data/state.json',JSON.parse(await readFile(${JSON.stringify(saved)}))); await unlink(${JSON.stringify(saved)});`);
  await probe.compose(['start', 'controller']);
}
console.log('PASS: real Docker backup preflight refuses queue history without creating output or changing container states');
