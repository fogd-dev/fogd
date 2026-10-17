import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fingerprint, writeJson } from '../../recovery/bundle.mjs';
import { execute } from '../../recovery/execute.mjs';
import { connection } from './connection.mjs';
import { observeStops, uncertainStops } from './stop-evidence.mjs';
import { verifyImageArchive } from './image-archive.mjs';
import { inventory } from './inventory.mjs';
import { stop, withHelper, archiveClaim, noPods } from './pods.mjs';

export async function kubeBackup(installation, directory, kubeconfig, context) {
  const conn = await connection(kubeconfig, context);
  const data = await inventory(conn, resolve(installation));
  const namespace = data.topology.namespace, dir = resolve(directory);
  await mkdir(dir, { mode: 0o700 });
  const started = Date.now();
  await writeJson(join(dir, 'started.json'), { namespace, startedAt: new Date().toISOString(), images: data.images });
  const observer = await observeStops(conn, namespace, data.pods);
  let failure;
  console.log(`Stopping Kubernetes installation ${namespace}`);
  try { await stop(conn, namespace); } catch (error) { failure = error; }
  const exits = await observer.finish();
  await writeJson(join(dir, 'stop.json'), { complete: !failure, observedAt: new Date().toISOString(), exits, uncertain: uncertainStops(exits) });
  if (failure) throw failure;
  const stoppedAt = new Date().toISOString();
  if (uncertainStops(exits).length) console.warn(`Crash recovery may be required; clean exits were not proven for: ${uncertainStops(exits).join(', ')}`);
  await writeJson(join(dir, 'manifests.json'), data.desired);
  await writeJson(join(dir, 'secrets.json'), data.secrets);
  await writeJson(join(dir, 'topology.json'), data.topology);
  const files = {};
  for (const claim of data.pvc) {
    const name = claim.metadata.name;
    console.log(`Archiving ${name}`);
    await withHelper(conn, namespace, name, data.placement[name], data.topology.images.runtime, true, async exec => {
      files[`${name}.tar`] = await archiveClaim(exec, join(dir, `${name}.tar`));
    });
  }
  await noPods(conn, namespace);
  await execute('docker', ['image', 'save', ...Object.keys(data.images)], { output: join(dir, 'images.tar') });
  await verifyImageArchive(join(dir, 'images.tar'), data.images);
  for (const file of ['manifests.json', 'secrets.json', 'topology.json', 'images.tar', 'started.json', 'stop.json']) files[file] = await fingerprint(join(dir, file));
  const pvc = data.pvc.map(c => ({ name: c.metadata.name, uid: c.metadata.uid, volume: c.spec.volumeName, spec: { accessModes: c.spec.accessModes, storageClassName: c.spec.storageClassName, resources: c.spec.resources }, node: data.placement[c.metadata.name] }));
  const pods = data.pods.map(p => ({ name: p.metadata.name, uid: p.metadata.uid, node: p.spec.nodeName, containers: p.status.containerStatuses.map(s => ({ name: s.name, restartCount: s.restartCount, imageID: s.imageID, lastState: s.lastState })) }));
  await writeJson(join(dir, 'manifest.json'), { format: 'fogd-kube-stopped-v1', namespace, cluster: conn.cluster, stoppedAt, durationMs: Date.now() - started, files, images: data.images, pvc, pods });
  console.log(`Snapshot complete: ${dir}. Source remains stopped.`);
}
