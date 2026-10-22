import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stageArtifact } from '../../../packages/runtime/src/artifact.mjs';
import { manifest } from '../../../packages/runtime/src/manifest.mjs';
import { scopedClient } from './https.mjs';

// Deliberate native boundary control, not a new application/framework profile.
// If celld forwards its reserved health path to the app, this worker records it
// and returns503. Ordinary application traffic is unavailable by construction.
export async function observationControl(host, token) {
  const project = join(host.output, 'health-control');
  await mkdir(join(project, 'dist/ssr'), { recursive: true, mode: 0o700 });
  await mkdir(join(project, 'db/migrations'), { recursive: true, mode: 0o700 });
  const worker = `export default {async fetch(request,env){
const path=new URL(request.url).pathname;
if(path==='/__void/ready')return Response.json({ready:true});
if(path==='/.well-known/celld/health'){await env.DB.prepare('UPDATE health_trap SET hits=hits+1 WHERE id=1').run();return new Response('APP_HEALTH_TRAP',{status:503});}
if(path==='/counter')return Response.json(await env.DB.prepare('SELECT hits FROM health_trap WHERE id=1').first());
return new Response('APP_UNAVAILABLE',{status:503});}};\n`;
  await writeFile(join(project, 'dist/ssr/index.js'), worker, { mode: 0o600 });
  await writeFile(join(project, 'dist/ssr/wrangler.json'), JSON.stringify({ main: 'index.js', d1_databases: [{ binding: 'DB' }] }), { mode: 0o600 });
  await writeFile(join(project, 'db/migrations/0001_health_trap.sql'), 'CREATE TABLE health_trap(id INTEGER PRIMARY KEY,hits INTEGER NOT NULL);INSERT INTO health_trap VALUES(1,0);', { mode: 0o600 });
  const release = await stageArtifact({ projectDir: project, outputDir: join(project, 'artifact'), app: 'replacement' });
  const submit = await scopedClient(host, token), response = await submit('/v1/deployments', { method: 'POST', body: JSON.stringify(await manifest(join(project, 'artifact'), release)), headers: { 'Content-Type': 'application/json' } });
  assert.equal(response.status, 201); const pending = response.json();
  await host.json(['admin', 'approve', pending.id, pending.digest]);
  return pending;
}
