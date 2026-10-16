import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { request } from './http.mjs';

const env = { ...process.env, FOGD_APP: process.env.FOGD_APP || 'notebook', FOGD_APP_HOST: process.env.FOGD_APP_HOST || 'notebook.localhost' };
const origin = process.env.FOGD_URL || 'http://127.0.0.1:8787';
const headers = { Host: env.FOGD_APP_HOST, 'Content-Type': 'application/json' };
const started = new Date().toISOString();
const run = (args, capture = false) => new Promise((resolve, reject) => {
  const child = spawn('docker', ['compose', ...args], { env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  let output = '';
  child.stdout?.on('data', data => { output += data; });
  child.stderr?.on('data', data => { output += data; });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`docker compose exited ${code}`)));
});
async function read() {
  const response = await request(`${origin}/api/entries`, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Read returned ${response.status}`);
  return response.json();
}
async function eventually(check, label) {
  const until = Date.now() + 120000;
  let last;
  while (Date.now() < until) {
    try { const value = await check(); console.log(`${label}: passed`); return value; }
    catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  throw new Error(`${label}: ${last?.message}`);
}
const before = await eventually(read, 'Initial readiness');
const entry = { id: `recovery-${Date.now()}`, title: 'Persistence check', body: 'R2 survives replica loss' };
let expectedCount = before.count + 1;
const expectedEntries = [entry];
const put = async (value = entry) => {
  const response = await request(`${origin}/api/entries`, { method: 'PUT', headers, body: JSON.stringify(value) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
assert.equal((await put()).count, before.count + 1);
assert.equal((await put()).count, before.count + 1, 'Duplicate operation must not increment the DO ledger');
async function verify() {
  const after = await read();
  assert.equal(after.count, expectedCount);
  for (const expected of expectedEntries) assert.deepEqual(after.entries.find(row => row.id === expected.id), expected);
}
try {
  for (const replica of ['celld-a', 'celld-b']) {
    // A zero-grace stop SIGKILLs the container and leaves it stopped during verification.
    await run(['stop', '-t', '0', replica]);
    await eventually(verify, `Acknowledged D1/R2/DO data with ${replica} killed`);
    await run(['start', replica]);
    const peer = replica === 'celld-a' ? 'celld-b' : 'celld-a';
    await run(['exec', '-T', peer, 'node', '--input-type=module', '-e', `
      for (let n=0;n<180;n++) {
        try { const r=await fetch('http://${replica}:8080/.well-known/celld/health'); if(r.ok) process.exit(0); } catch {}
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      process.exit(1);
    `]);
    await eventually(verify, `${replica} rejoined`);
    if (replica === "celld-a") {
      const extra = { ...entry, id: `${entry.id}-rejoin` };
      expectedEntries.push(extra); expectedCount++;
      assert.equal((await put(extra)).count, expectedCount);
    }
    const logs = await run(["logs", "--since", started, "celld-a", "celld-b"], true);
    assert.ok(!logs.includes("no complete true witness"), "Recovery must retain an addressable log witness");
  }
  await run(['restart', 'workerd']);
  await eventually(verify, 'workerd restart');
  const internal = await request(`${origin}/__void/migrate`, { headers, method: 'POST' });
  assert.equal(internal.status, 404);
  console.log(JSON.stringify({ ok: true, entries: expectedEntries, count: expectedCount }));
} finally {
  await run(['start', 'celld-a', 'celld-b']);
}
