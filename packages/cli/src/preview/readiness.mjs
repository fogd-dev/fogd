import { setTimeout as delay } from 'node:timers/promises';
import { hostRefusal } from './host-records.mjs';

function readinessCode(role, value) {
  const q = JSON.stringify, origin = new URL(value.plan.request.origin), grant = value.snapshot.grant;
  if (role === 'minio') return `const r=await fetch('http://127.0.0.1:9000/minio/health/live',{redirect:'error',signal:AbortSignal.timeout(1000)});await r.body?.cancel();return r.status===200;`;
  if (role.startsWith('slot-')) return `const {createConnection}=await import('node:net');return await new Promise(resolve=>{const s=createConnection({host:${q(role)},port:8080});const done=v=>{s.destroy();resolve(v)};s.once('connect',()=>done(true));s.once('error',()=>done(false));s.setTimeout(1000,()=>done(false));});`;
  if (role === 'controller') return `const r=await fetch('http://controller:8083/internal/preview',{headers:{authorization:${q('Bearer ' + value.bundle.gateway.gatewayToken)}},redirect:'error',signal:AbortSignal.timeout(1000)});if(r.status!==200){await r.body?.cancel();return false}const v=await r.json();return v.status==='active'&&v.preview===${q(grant.preview)}&&v.app===${q(grant.source.app)}&&v.submission===${q(grant.source.submission)}&&v.digest===${q(grant.source.digest)}&&v.expiresAt===${q(grant.expiresAt)}&&v.productionActivation===false;`;
  const config = value.bundle[role];
  if (role === 'gateway') return `const {connect}=await import('node:tls');return await new Promise(resolve=>{const s=connect({host:'gateway',port:8080,servername:${q(origin.hostname)},ca:${q(config.tls.cert)},rejectUnauthorized:true});const done=v=>{s.destroy();resolve(v)};s.once('secureConnect',()=>done(s.authorized));s.once('error',()=>done(false));s.setTimeout(1000,()=>done(false));});`;
  return `const {request}=await import('node:https');return await new Promise(resolve=>{const r=request({hostname:'ingress',port:8080,servername:${q(origin.hostname)},ca:${q(config.tls.cert)},rejectUnauthorized:true,agent:false,path:'/',headers:{host:${q(origin.host)}}},s=>{s.resume();resolve(s.statusCode===401)});r.once('error',()=>resolve(false));r.setTimeout(1000,()=>r.destroy());r.end();});`;
}

// Read-only probes only: TCP/TLS handshakes, storage health, authenticated
// controller identity and denied ingress. Never invoke an application handler.
export async function awaitPreviewReady(value, role, run, live) {
  const deadline = Date.now() + 10000, probe = readinessCode(role, value);
  const code = `try{const ready=await(async()=>{${probe}})();console.log(JSON.stringify({ready}))}catch{console.log(JSON.stringify({ready:false}))}`;
  for (;;) {
    live();
    const { roles } = await value.observe('operating');
    if (!roles[role].State.Running) hostRefusal('startup-exited');
    const output = JSON.parse(await run(['exec', value.complete.identities.containers.minio, '/usr/local/bin/node', '--input-type=module', '-e', code]));
    if (Object.keys(output).length !== 1 || typeof output.ready !== 'boolean') hostRefusal('startup-readiness');
    if (output.ready) return;
    if (Date.now() >= deadline) hostRefusal('startup-readiness');
    await delay(100);
  }
}
