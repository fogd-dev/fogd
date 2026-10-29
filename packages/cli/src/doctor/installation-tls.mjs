import { randomUUID } from 'node:crypto';
import { docker } from '../recovery/docker.mjs';
import { cleanupObserver } from '../observe/cleanup.mjs';

// The caller verifies the image and owned local backing path before this read.
// Bind mounts refuse a deleted source instead of recreating a named volume.
export async function inspectInstallationTLS(installation, backing, run = docker) {
  const tls = backing.volumes.find(volume => volume.role === 'tls');
  if (!tls) throw new Error('Installed TLS backing path is unavailable');
  const nonce = randomUUID(), name = `fogd-doctor-tls-${nonce}`;
  const code = "import{loadTLS}from'./packages/runtime/src/transport.mjs';await loadTLS({FOGD_TLS:'1',FOGD_TLS_FILE:'/tls/keypair.json'});console.log(JSON.stringify({valid:true}));";
  try {
    const result = await run(['run', '--rm', '--pull', 'never', '--name', name, '--label', `fogd.observer.id=${nonce}`, '--label', `fogd.observer.project=${installation.project}`,
      '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '0.25', '--pids-limit', '32',
      '--mount', `type=bind,src=${tls.mountpoint},dst=/tls,readonly`, '--entrypoint', '/usr/local/bin/node', installation.entry.image, '--input-type=module', '-e', code], { timeoutMs: 15000, maxOutputBytes: 4096 });
    if (JSON.stringify(JSON.parse(result)) !== '{"valid":true}') throw new Error('TLS observation could not be decoded');
  } finally { await cleanupObserver(name, nonce, run); }
}
