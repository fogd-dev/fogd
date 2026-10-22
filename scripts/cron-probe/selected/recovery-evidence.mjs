import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { json, stopped } from '../../../packages/cli/src/recovery/docker.mjs';
import { assertNoSecrets } from './privacy.mjs';

export function recordRequests(host, request, journal) {
  return async (path, options = {}) => {
    journal.push({ project: host.project, method: options.method || 'GET', app: options.app || null, path, at: Date.now() });
    return request(path, options);
  };
}
export async function retainedInstallations(installations) {
  const volumes = installations.flatMap(host => Object.values(host.config.volumes).map(volume => volume.name));
  assert.equal(volumes.length, 32); assert.equal(new Set(volumes).size, 32);
  const inspected = await json(['volume', 'inspect', ...volumes]); assert.deepEqual(inspected.map(volume => volume.Name).sort(), volumes.toSorted());
  for (const host of installations) await stopped(host.project, Object.values(host.config.volumes).map(volume => volume.name));
  return volumes;
}
export async function scanRecoveryOutputs(installations, fixture, receipt) {
  const host = installations[0], settings = parseEnv(await readFile(host.env.FOGD_ENV_FILE, 'utf8'));
  const secrets = [fixture.secret, ...Object.values(fixture.tokens), settings.FOGD_ADMIN_PASSWORD, settings.FOGD_GATEWAY_TOKEN,
    ...installations.flatMap(value => { const env = value.config.services.controller.environment; return [env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY]; })];
  const surfaces = [JSON.stringify(receipt)], files = [];
  for (const installation of installations) {
    const names = (await readdir(installation.output)).filter(name => name === 'runtime.log' || /^command-failure-.*\.json$/.test(name));
    assert.ok(names.includes('runtime.log'));
    for (const name of names) {
      const text = await readFile(join(installation.output, name), 'utf8'); files.push({ project: installation.project, name });
      if (name === 'runtime.log') surfaces.push(text);
      else { const diagnostic = JSON.parse(text); surfaces.push(diagnostic.stdout || '', diagnostic.stderr || ''); }
    }
  }
  return { ...assertNoSecrets(surfaces, secrets), files, finalReceiptChecked: true };
}
