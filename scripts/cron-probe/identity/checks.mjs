import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { verifyIdentityProof, storageOrigin } from '../../../packages/platform/src/runtime-identity-proof.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

export async function observe(probe, host, path = '/runtime/identity', method = 'GET') {
  return JSON.parse(await probe.node(`try {const r=await fetch(${JSON.stringify(`http://${host}:8082${path}`)},
    {method:${JSON.stringify(method)},signal:AbortSignal.timeout(2000)});
    console.log(JSON.stringify({status:r.status,cache:r.headers.get('cache-control'),body:await r.text()}));}
    catch(error) {console.log(JSON.stringify({unavailable:true,code:error.cause?.code||error.name}));}`));
}
export async function identity(probe, host, expectedBinary, { endpoint = 'http://minio:9000', region = 'us-east-1', namespace = 's3://identity-probe/slots/one' } = {}) {
  const challenge = randomBytes(32).toString('hex');
  const response = await observe(probe, host, `/runtime/identity?challenge=${challenge}`);
  assert.equal(response.status, 200);
  assert.equal(response.cache, 'no-store');
  const proof = JSON.parse(response.body), value = verifyIdentityProof(proof, challenge);
  assert.deepEqual(value, { schema: 2, binarySha256: expectedBinary,
    nodeSha256: hash(host), namespaceSha256: hash(namespace),
    storageSha256: hash(JSON.stringify([namespace, storageOrigin(endpoint), region])),
    processKeySha256: hash(proof.publicKey) });
  return proof;
}

export async function bucketSnapshot(probe, endpoint) {
  const target = endpoint === undefined ? 'process.env.S3_ENDPOINT' : JSON.stringify(endpoint);
  return JSON.parse(await probe.node(`import {createRequire} from 'node:module';
    import {createHash} from 'node:crypto';import {bucketClient} from './packages/runtime/src/bucket.mjs';
    const require=createRequire('/app/packages/platform/src/backend.mjs');
    const {ListObjectsV2Command,GetObjectCommand}=require('@aws-sdk/client-s3');
    const client=bucketClient({...process.env,S3_ENDPOINT:${target}}), Bucket=process.env.FOGD_BUCKET;
    const listing=await client.send(new ListObjectsV2Command({Bucket}));
    if(listing.IsTruncated)throw Error('Unexpected truncated fixture bucket');
    const rows=await Promise.all((listing.Contents||[]).map(async({Key})=>{
      const r=await client.send(new GetObjectCommand({Bucket,Key}));
      return {key:Key,sha256:createHash('sha256').update(await r.Body.transformToByteArray()).digest('hex')};}));
    console.log(JSON.stringify(rows.sort((a,b)=>a.key.localeCompare(b.key))));`));
}
export async function protocol(probe) {
  const outcomes = [];
  for (const [path, method, status] of [['/state', 'GET', 404], ['/runtime/identity', 'POST', 405], ['/runtime/identity?x=1', 'GET', 400]]) {
    const result = await observe(probe, 'a', path, method);
    assert.equal(result.status, status);
    outcomes.push({ path, method, ...result });
  }
  const slow = JSON.parse(await probe.node(`import net from 'node:net';
    const started=performance.now();const socket=net.connect(8082,'a');
    socket.on('error',()=>{});await new Promise(r=>socket.once('connect',r));socket.write('GET /runtime/identity HTTP/1.1\\r\\n');
    const closed=new Promise(r=>socket.once('close',r));socket.resume();
    const healthy=await fetch('http://a:8082/runtime/identity',{signal:AbortSignal.timeout(2000)});
    await healthy.text();await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('stalled connection retained')),7500))]);
    console.log(JSON.stringify({healthyStatus:healthy.status,closedAfterMs:performance.now()-started}));`));
  assert.equal(slow.healthyStatus, 200);
  assert.ok(slow.closedAfterMs >= 4000 && slow.closedAfterMs < 7500);
  return { outcomes, slow };
}
