import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export function assertNoSecrets(values, secrets) {
  assert.ok(secrets.length > 0);
  for (const secret of secrets) {
    assert.equal(typeof secret, 'string', 'Missing credential in qualification input');
    assert.ok(secret.length > 0, 'Missing credential in qualification input');
    for (const value of values) assert.equal(Buffer.from(value).includes(Buffer.from(secret)), false, 'Private value appeared in an ordinary surface or receipt');
  }
  return { valuesChecked: values.length, credentialValuesChecked: secrets.length };
}

export function assertArtifactNoSecrets(artifact, secrets) {
  assert.ok(Array.isArray(artifact.files) && artifact.files.length >= 2, 'Expected a downloadable artifact manifest');
  const files = artifact.files.map(file => {
    assert.equal(typeof file.data, 'string');
    const bytes = Buffer.from(file.data, 'base64'); assert.equal(bytes.toString('base64'), file.data, 'Artifact file encoding is invalid'); return bytes;
  });
  return { ...assertNoSecrets([JSON.stringify(artifact), ...files], secrets), filesChecked: files.length };
}

export async function scanPublicSurfaces(host, request, submissions, token, appSecrets, receipt) {
  const settings = parseEnv(await readFile(host.env.FOGD_ENV_FILE, 'utf8')), env = host.config.services.controller.environment;
  const secrets = [...appSecrets, token, settings.FOGD_ADMIN_PASSWORD, settings.FOGD_GATEWAY_TOKEN, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY];
  const surfaces = [JSON.stringify(receipt)];
  for (const path of ['/v1/admin', '/']) {
    const response = await request(path); assert.equal(response.status, 200); surfaces.push(response.text);
  }
  for (const submitted of submissions) {
    const artifact = await request(`/v1/deployments/${submitted.id}/artifact`); assert.equal(artifact.status, 200);
    assertArtifactNoSecrets(artifact.json(), secrets);
    surfaces.push(JSON.stringify(await host.json(['status', submitted.id], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token } })));
  }
  const diagnostics = (await readdir(host.output)).filter(name => /^command-failure-.*\.json$/.test(name));
  for (const file of diagnostics) { const diagnostic = JSON.parse(await readFile(join(host.output, file), 'utf8')); surfaces.push(diagnostic.stdout || '', diagnostic.stderr || ''); }
  assertNoSecrets(surfaces, secrets);
  return { adminJSON: true, adminHTML: true, scopedStatuses: submissions.length, decodedArtifacts: submissions.length, privateDiagnosticsChecked: diagnostics.length, completeReceiptChecked: true };
}

export async function scanOutputFiles(installations, fixture, receipt, rawSurfaces = []) {
  const host = installations[0], settings = parseEnv(await readFile(host.env.FOGD_ENV_FILE, 'utf8'));
  const secrets = [fixture.secret, ...(fixture.secrets || []), ...Object.values(fixture.tokens), settings.FOGD_ADMIN_PASSWORD, settings.FOGD_GATEWAY_TOKEN,
    ...installations.flatMap(value => { const env = value.config.services.controller.environment; return [env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY]; })];
  const surfaces = [JSON.stringify(receipt), ...rawSurfaces], files = [];
  for (const installation of installations) {
    const names = (await readdir(installation.output)).filter(name => name === 'runtime.log' || name === 'runtime-failure.log' || name === 'preparation-peer.log' || /^(?:command-failure-|observer-).*\.json$/.test(name));
    assert.ok(names.includes('runtime.log'));
    for (const name of names) {
      const text = await readFile(join(installation.output, name), 'utf8'); files.push({ project: installation.project, name });
      if (name.endsWith('.log')) surfaces.push(text);
      else { const diagnostic = JSON.parse(text); surfaces.push(diagnostic.stdout || '', diagnostic.stderr || ''); }
    }
  }
  return { ...assertNoSecrets(surfaces, secrets), files, finalReceiptChecked: true };
}
