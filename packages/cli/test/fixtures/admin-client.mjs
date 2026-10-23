import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../../bin/fogd.js', import.meta.url));

export async function adminCliFixture(t, { respond, command, defaults }) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-admin-client-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], server = createServer((request, response) => {
    calls.push({ path: request.url, method: request.method, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json'); respond(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { PATH: process.env.PATH, HOME: root, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'operator.env'),
    FOGD_SERVER: `http://127.0.0.1:${server.address().port}`, FOGD_ADMIN_PASSWORD: 'private-admin-password', FOGD_DEPLOY_TOKEN: 'private-builder-token' };
  const invoke = (args = defaults, extra = {}) => exec(process.execPath, [cli, 'admin', command, ...args], {
    env: { ...env, ...extra }, timeout: 20000, maxBuffer: 1024 ** 2,
  });
  return { calls, env, invoke, root };
}
