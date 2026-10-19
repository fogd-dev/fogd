// Private qualification artifacts only: this deliberately bypasses upload admission.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { artifactDigest, resourceIdentity } from '/app/packages/runtime/src/artifact.mjs';
import { requireQueueCapability } from '/app/packages/platform/src/queue-activation.mjs';

export async function stageRequest(controller, source, amend = async () => {}) {
  const id = randomUUID(), artifact = controller.artifact(id);
  await mkdir(artifact);
  for (const path of ['worker', 'migrations', 'wrangler.json']) await cp(join(source, path), join(artifact, path), { recursive: true });
  const config = JSON.parse(await readFile(join(artifact, 'wrangler.json'), 'utf8'));
  await amend(artifact, config);
  await writeFile(join(artifact, 'wrangler.json'), JSON.stringify(config));
  const migrations = [];
  for (const db of config.d1_databases) for (const name of (await readdir(join(artifact, db.migrations_dir))).sort()) {
    migrations.push({ database: db.database_id, name, digest: createHash('sha256').update(await readFile(join(artifact, db.migrations_dir, name))).digest('hex') });
  }
  const request = { id, app: config.name, digest: await artifactDigest(artifact), resources: { ...resourceIdentity(config), queues: config.queues }, migrations, requiredSecrets: [], status: 'pending', step: 'submitted', submitter: 'qualification-fixture', submittedAt: new Date().toISOString() };
  requireQueueCapability(controller.state, request.resources);
  controller.state.deployments[id] = request; await controller.save(); return request;
}
