import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../../src/controller.mjs';
import { server } from '../../src/http.mjs';
import { stageArtifact } from '@fogd/runtime/artifact';
import { manifest } from '@fogd/runtime/manifest';

export async function decisionFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-decisions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owners = {}, effects = []; let publish;
  const backend = { owner: async slot => owners[slot.id] || null, hasDeployment: async () => false,
    assertUnclaimed: async () => {}, claim: async (slot, app) => { effects.push('claim'); owners[slot.id] = { app }; },
    publish: async (...args) => { effects.push('publish'); if (publish) await publish(...args); return 'version'; },
    ready: async () => {}, applicationReady: async () => {}, migrate: async () => { effects.push('migrate'); }, applied: async () => [] };
  const settings = { dir: join(root, 'controller'), slots: [{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }, { id: 'two', prefix: 'two', nodes: ['c', 'd'] }], backend, reportStorageFailure: () => {}, ...options };
  const controller = new Controller(settings); await controller.init();
  let sequence = 0;
  const submit = async (app = 'demo') => {
    const project = join(root, `project-${sequence++}`); await mkdir(join(project, 'dist/ssr'), { recursive: true });
    await writeFile(join(project, 'dist/ssr/index.js'), `export default {fetch(){return new Response(${sequence})}}`);
    await writeFile(join(project, 'dist/ssr/wrangler.json'), '{"main":"index.js","vars":{"STATIC":"private-artifact-literal"}}');
    const staged = join(project, 'artifact'), release = await stageArtifact({ projectDir: project, outputDir: staged, app });
    return controller.submit(await manifest(staged, release), 'team-token');
  };
  const credentials = { user: 'ops<&>', password: 'private-admin-password', gateway: 'private-gateway' };
  const authorization = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`;
  const listen = async (selected = controller) => {
    const http = server(selected, credentials); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
    const origin = `http://127.0.0.1:${http.address().port}`;
    const get = (path, auth = authorization) => fetch(origin + path, { headers: auth ? { authorization: auth } : {} });
    const decide = async (request, action, input = {}) => {
      const { csrf } = await (await get('/v1/admin')).json();
      return fetch(`${origin}/v1/deployments/${request.id}/${action}`, { method: 'POST', headers: { authorization, 'content-type': 'application/json', 'x-fogd-csrf': csrf }, body: JSON.stringify({ digest: request.digest, ...input }) });
    };
    return { get, decide, origin, authorization };
  };
  return { root, controller, settings, submit, listen, effects, onPublish: callback => { publish = callback; } };
}
