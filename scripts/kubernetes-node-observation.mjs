import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kubernetesClient } from './kubernetes-client.mjs';
import { platformClient } from './platform-client.mjs';
import { request } from './http.mjs';
import { expect } from './guestbook-browser.mjs';
import { run } from '../packages/cli/src/local.mjs';
const cluster = await kubernetesClient(process.argv[2] || '.fogd/m9a');
const client = await platformClient({ ...cluster.env, FOGD_SERVER: 'https://127.0.0.1:8788', FOGD_URL: 'https://127.0.0.1:8787' });
const forward = cluster.forward('workerd', 8787, 8080);
let stopped = false;
const pods = JSON.parse(await cluster.kube(['get', 'pods', '-o', 'json'], true)).items;
const node = pods.find(p => p.metadata.name === 'slot-2-0').spec.nodeName;
assert.ok([`${cluster.cluster}-worker`, `${cluster.cluster}-worker2`].includes(node));
const observations = [];
try {
  await expect.poll(async () => { try { return (await client.appRequest('notebook', '/api/entries')).status; } catch { return 0; } }, { timeout: 30000 }).toBe(200);
  const before = await (await client.appRequest('notebook', '/api/entries')).json();
  await run('docker', ['stop', '-t', '0', node]); stopped = true;
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    try {
      const response = await request('https://127.0.0.1:8787/api/entries', { headers: { Host: 'notebook.localhost' }, signal: AbortSignal.timeout(3000) });
      await response.body?.cancel(); observations.push({ at: new Date().toISOString(), status: response.status });
    } catch { observations.push({ at: new Date().toISOString(), status: 'unavailable' }); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await run('docker', ['start', node]); stopped = false;
  // A forward pins one pod; reconnect after its node returns.
  forward.kill('SIGTERM');
  await cluster.kube(['wait', '--for=condition=Ready', 'pod', '-l', 'app.kubernetes.io/part-of=fogd', '--timeout=180s']);
  const recovered = cluster.forward('workerd', 8787, 8080);
  try {
    await expect.poll(async () => { try { return (await client.appRequest('notebook', '/api/entries')).status; } catch { return 0; } }, { timeout: 120000 }).toBe(200);
    assert.deepEqual(await (await client.appRequest('notebook', '/api/entries')).json(), before);
  } finally { recovered.kill('SIGTERM'); }
  const evidence = { node, colocatedPods: pods.filter(p => p.spec.nodeName === node).map(p => p.metadata.name), observations, recoveredData: true, qualification: 'Local kind node stop/start only; no physical-host or replacement-volume resilience claim' };
  await writeFile(join(cluster.root, 'node-observation.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence));
} finally { if (stopped) await run('docker', ['start', node]); forward.kill('SIGTERM'); }
