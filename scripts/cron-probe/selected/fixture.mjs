import assert from 'node:assert/strict';
import { cp, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const source = fileURLToPath(new URL('../../../examples/refresh/', import.meta.url));
export async function deployFixture(host, token, label) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(label)) throw new Error('Invalid fixture release label');
  const directory = join(host.output, label);
  await cp(source, directory, { recursive: true, filter: path => !['node_modules', '.void', 'dist', '.wrangler'].includes(basename(path)) });
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const job = join(directory, 'lib/refresh.mjs'), route = join(directory, 'routes/api/refresh.ts');
  const jobSource = await readFile(job, 'utf8'), routeSource = await readFile(route, 'utf8');
  assert.equal(jobSource.split('const value = source(').length, 2);
  assert.equal(routeSource.split('defineHandler(c => summary(c.env.DB))').length, 2);
  const jobText = jobSource.replace('const value = source(', `const value = ${JSON.stringify(label + ':')} + source(`);
  const routeText = routeSource.replace('defineHandler(c => summary(c.env.DB))', `defineHandler(async c => ({ ...await summary(c.env.DB), release: ${JSON.stringify(label)} }))`);
  await writeFile(job, jobText); await writeFile(route, routeText);
  const sha256 = text => createHash('sha256').update(text).digest('hex');
  const submitted = await host.json(['deploy', '--name', 'refresh'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: directory });
  assert.equal(submitted.status, 'pending');
  return { ...submitted, label, fixtureChanges: { 'lib/refresh.mjs': sha256(jobText), 'routes/api/refresh.ts': sha256(routeText) } };
}
