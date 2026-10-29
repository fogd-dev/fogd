import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { inspectInstallationTLS } from '../src/doctor/installation-tls.mjs';
import { execute } from '../src/recovery/execute.mjs';

async function certificate(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-doctor-live-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyPath = join(root, 'key.pem'), certPath = join(root, 'cert.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  const cert = await readFile(certPath, 'utf8'), key = await readFile(keyPath, 'utf8');
  return { root, certPath, cert, key, fingerprint: new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase() };
}

test('installed TLS reader classifies DNS and IP coverage without returning key material', async t => {
  const pair = await certificate(t), path = join(pair.root, 'keypair.json');
  await writeFile(path, JSON.stringify({ cert: pair.cert, key: pair.key }), { mode: 0o600 });
  for (const [hostname, expected] of [['localhost', true], ['127.0.0.1', true], ['wrong.example.test', false]]) {
    const result = await inspectInstallationTLS({ project: 'sample', entry: { image: 'verified' } }, { volumes: [{ role: 'tls', mountpoint: '/owned' }] }, async (args, options) => {
      if (args[0] !== 'run') return '';
      const code = args.at(-1).replace("'/tls/keypair.json'", JSON.stringify(path));
      return execute(process.execPath, ['--input-type=module', '-e', code], options);
    }, hostname);
    assert.deepEqual(result, { valid: true, hostnameMatches: expected, fingerprint: pair.fingerprint });
    assert.ok(!JSON.stringify(result).includes('BEGIN'));
  }
});

test('real client trust accepts the matching trusted leaf and refuses untrusted or substituted leaves without HTTP', async t => {
  const pair = await certificate(t); let applicationBytes = 0;
  const sockets = new Set(), server = createServer({ cert: pair.cert, key: pair.key }, socket => {
    sockets.add(socket); socket.on('data', bytes => { applicationBytes += bytes.length; }); socket.on('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const module = new URL('../src/doctor/tls-endpoint.mjs', import.meta.url).href;
  const program = `import{inspectClientTrust}from ${JSON.stringify(module)};console.log(JSON.stringify(await inspectClientTrust({hostname:'127.0.0.1',port:${server.address().port}},process.argv[1])));`;
  for (const [trusted, fingerprint, status] of [[true, pair.fingerprint, 'supported'], [false, pair.fingerprint, 'unsupported'], [true, 'a'.repeat(64), 'unsupported']]) {
    const env = { ...process.env }; delete env.NODE_EXTRA_CA_CERTS;
    if (trusted) env.NODE_EXTRA_CA_CERTS = pair.certPath;
    const output = await execute(process.execPath, ['--input-type=module', '-e', program, fingerprint], { env, timeoutMs: 10000 });
    assert.equal(JSON.parse(output).status, status); assert.ok(!output.includes('BEGIN'));
  }
  assert.equal(applicationBytes, 0);
});
