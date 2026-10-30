import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import {
  createPreviewExecutionAuthority,
  previewExecutionSha256,
  signPreviewExecution,
} from '../src/preview/execution-authority.mjs';
import { readPreviewService } from '../src/preview/service-input.mjs';
import { previewBackendCommand } from '../src/preview/backend.mjs';
import { previewGatewayConfig } from '../src/preview/gateway.mjs';

const refused = { code: 'PREVIEW_EXECUTION_REFUSED' };

async function fixture(t, role) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-preview-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trustDirectory = join(root, 'trust'), inputDirectory = join(root, 'input');
  for (const path of [trustDirectory, inputDirectory]) await mkdir(path, { mode: 0o700 });
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    join(root, 'key.pem'),
    '-out',
    join(root, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    '/CN=demo.preview.test',
    '-addext',
    'subjectAltName=DNS:demo.preview.test',
  ]);
  const tls = {
      key: await readFile(join(root, 'key.pem'), 'utf8'),
      cert: await readFile(join(root, 'cert.pem'), 'utf8'),
    },
    runtime = { family: 'preview-fixture', catalogEntrySha256: '1'.repeat(64) };
  const grant = {
    schema: 1,
    purpose: 'preview-execution',
    id: randomUUID(),
    preview: randomUUID(),
    preparationSha256: '2'.repeat(64),
    source: {
      controller: 'https://source.test',
      app: 'demo',
      submission: randomUUID(),
      digest: '3'.repeat(64),
      reviewSha256: '4'.repeat(64),
    },
    target: {
      project: 'preview-service',
      installation: '5'.repeat(64),
      configSha256: '6'.repeat(64),
      runtime,
      origin: 'https://demo.preview.test:8080',
      networks: {
        control: '10.249.1.0/24',
        'fleet-1': '10.249.2.0/24',
        'fleet-2': '10.249.3.0/24',
        frontend: '10.249.4.0/24',
      },
    },
    policy: {
      lifetimeSeconds: 60,
      storage: 'fresh-empty-only',
      secrets: 'preview-only',
      requiredSecrets: [],
      background: 'disabled',
      network: 'no-external-egress',
      access: 'owner-authenticated',
      expiry: 'deny-requests-and-stop-writers',
      dataPromotion: 'none',
    },
    actor: { kind: 'local-owner', uid: process.getuid() },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    productionActivation: false,
  };
  // Derive expiry from the canonical issue instant, including millisecond rollover.
  grant.expiresAt = new Date(Date.parse(grant.issuedAt) + 60000).toISOString();
  const authority = createPreviewExecutionAuthority(),
    envelope = signPreviewExecution(grant, authority.privateKey),
    config = role === 'gateway'
      ? { tls, gatewayToken: 'a'.repeat(64) }
      : { tls, accessKey: 'b'.repeat(64), upstreamCA: tls.cert };
  const trust = {
    schema: 1,
    role,
    publicKey: authority.publicKey,
    expectedGrantSha256: previewExecutionSha256(envelope),
    preparationSha256: grant.preparationSha256,
    target: grant.target,
    serviceSha256: hash(jsonBytes(config)),
  };
  const save = async () => {
    await writeFile(join(trustDirectory, 'trust.json'), jsonBytes(trust), { mode: 0o600 });
    await writeFile(join(inputDirectory, 'execution.json'), jsonBytes(envelope), { mode: 0o600 });
    await writeFile(join(inputDirectory, 'service.json'), jsonBytes(config), { mode: 0o600 });
  };
  await save();
  const options = { trustDirectory, inputDirectory, expiresAt: grant.expiresAt };
  return { grant, trust, config, save, read: () => readPreviewService(role, options), options };
}
for (const role of ['gateway', 'ingress']) {
  test(`signed ${role} inputs bind fixed TLS origin, independent authority and expiry`, async (t) => {
    const f = await fixture(t, role), input = await f.read();
    assert.equal(input.grant.productionActivation, false);
    assert.equal(input.grant.target.origin, 'https://demo.preview.test:8080');
    const command = previewBackendCommand(role, {
      FOGD_PREVIEW_EXPIRES_AT: f.grant.expiresAt,
      AWS_SECRET_ACCESS_KEY: 'source-secret',
      FOGD_PREVIEW_STORAGE_PASSWORD: 'source-secret',
      NODE_OPTIONS: '--inspect',
    });
    assert.equal(JSON.stringify(command).includes('source-secret'), false);
    assert.deepEqual(command.args, ['packages/cli/src/preview/service-main.mjs', role]);
    if (role === 'gateway') {
      const config = previewGatewayConfig(input);
      assert.ok(config.includes('controller:8083'));
      assert.ok(config.includes('slot-1-a:8080'));
      assert.ok(config.includes('slot-2-b:8080'));
      assert.ok(config.includes('https='));
    }
  });
}
for (const change of ['role', 'service-bytes', 'authority', 'expiry', 'unbound-endpoint']) {
  test(`service input refuses ${change}`, async (t) => {
    const f = await fixture(t, 'ingress');
    if (change === 'role') f.trust.role = 'gateway';
    if (change === 'authority') f.trust.publicKey = createPreviewExecutionAuthority().publicKey;
    if (change === 'service-bytes') f.config.accessKey = 'c'.repeat(64);
    if (change === 'expiry') f.options.expiresAt = new Date(Date.parse(f.grant.expiresAt) + 1).toISOString();
    if (change === 'unbound-endpoint') {
      f.config.target = 'https://other.test';
      f.trust.serviceSha256 = hash(jsonBytes(f.config));
    }
    await f.save();
    await assert.rejects(f.read(), refused);
  });
}
