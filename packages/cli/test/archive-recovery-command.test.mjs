import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { adminCliFixture } from './fixtures/admin-client.mjs';

const id='00000000-0000-4000-8000-000000000001',deployment='00000000-0000-4000-8000-000000000002';
const old='00000000-0000-4000-8000-000000000003',fresh='00000000-0000-4000-8000-000000000004',csrf='c'.repeat(64);
const selection={archive:id,identity:'a'.repeat(64),snapshot:'b'.repeat(64),deployment,digest:'f'.repeat(64),secretRevision:old};
const review=()=>({app:'alpha',state:'pending',execution:'held',selection:{...selection,private:'private-selection'},review:'d'.repeat(64),notice:'private-notice',version:'private-version'});
const approved=()=>({archive:id,identity:selection.identity,deployment,digest:selection.digest,state:'approved',execution:'held',version:'private-version'});
const fixture=(t,respond)=>adminCliFixture(t,{respond,command:'archive',defaults:['alpha','review']});
async function file(f,rotation=false){const path=join(f.root,'review.json');await f.invoke(['alpha','review',...(rotation?['--rotation']:[]),'--output',path]);return path;}

test('review uses authenticated GET, filters private fields and saves a fresh mode-0600 endpoint-bound file',async t=>{
 const f=await fixture(t,(_,response)=>response.end(JSON.stringify(review()))),path=join(f.root,'review.json');
 const result=JSON.parse((await f.invoke(['alpha','review','--output',path])).stdout);
 assert.equal(result.controller,f.env.FOGD_SERVER);assert.equal(result.kind,'original');assert.deepEqual(result.selection,selection);assert.equal(result.execution,'held');
 assert.equal((await stat(path)).mode&0o777,0o600);assert.deepEqual(JSON.parse(await readFile(path)),result);
 assert.doesNotMatch(JSON.stringify(result),/private-|csrf/);assert.deepEqual(f.calls.map(c=>[c.method,c.path]),[['GET','/v1/apps/alpha/archive-recovery']]);
 await assert.rejects(f.invoke(['alpha','review','--output',path]),/EEXIST/);
});

for(const rotation of [false,true])test(`explicit approval submits only the saved exact review; rotation=${rotation}`,async t=>{
 let sent,headers;const f=await fixture(t,(request,response)=>{
  if(request.url==='/v1/admin'){response.end(JSON.stringify({csrf}));return;}
  if(request.method==='GET'){response.end(JSON.stringify(review()));return;}
  headers=request.headers;let body='';request.on('data',b=>body+=b);request.on('end',()=>{sent=JSON.parse(body);response.end(JSON.stringify(approved()));});
 });const path=await file(f,rotation);const result=JSON.parse((await f.invoke(['alpha','approve','--review',path,...(rotation?['--rotation']:[])])).stdout);
 assert.deepEqual(sent,{...selection,review:'d'.repeat(64)});assert.equal(headers['x-fogd-csrf'],csrf);assert.equal(result.app,'alpha');assert.equal(result.kind,rotation?'rotation':'original');assert.equal(result.execution,'held');
 assert.doesNotMatch(JSON.stringify(result),/private-/);assert.deepEqual(f.calls.map(c=>[c.method,c.path]),[['GET','/v1/apps/alpha/archive-recovery'+(rotation?'/rotation':'')],['GET','/v1/admin'],['POST','/v1/apps/alpha/archive-recovery'+(rotation?'/rotation':'')+'/approve']]);
 assert.ok(f.calls.every(c=>c.authorization==='Basic '+Buffer.from('admin:private-admin-password').toString('base64')));
});

test('secret staging reads stdin once, sends PUT to the selected archive and prints revision names only',async t=>{
 let sent;const f=await fixture(t,(request,response)=>{
  if(request.url==='/v1/admin'){response.end(JSON.stringify({csrf}));return;}
  if(request.method==='GET'){response.end(JSON.stringify(review()));return;}
  let body='';request.on('data',b=>body+=b);request.on('end',()=>{sent=JSON.parse(body);response.end(JSON.stringify({app:'alpha',revision:fresh,names:['API_KEY'],values:{API_KEY:'private-new-value'}}));});
 });const path=await file(f),result=JSON.parse((await f.invoke(['alpha','secrets','--review',path],{},JSON.stringify({API_KEY:'private-new-value'}))).stdout);
 const {secretRevision,...selected}=selection;assert.deepEqual(sent,{...selected,values:{API_KEY:'private-new-value'}});
 assert.deepEqual(result,{schema:1,app:'alpha',revision:fresh,names:['API_KEY'],state:'staged',execution:'held'});
 assert.doesNotMatch(JSON.stringify(result),/private-new-value/);assert.equal(f.calls.at(-1).method,'PUT');assert.equal(f.calls.at(-1).path,'/v1/apps/alpha/archive-recovery/rotation/secrets');
});

test('changed endpoint or mismatched review mode refuses before another HTTP request',async t=>{
 const f=await fixture(t,(_,response)=>response.end(JSON.stringify(review()))),path=await file(f);
 await assert.rejects(f.invoke(['alpha','approve','--rotation','--review',path]),/review is invalid/);
 await assert.rejects(f.invoke(['alpha','approve','--review',path],{FOGD_SERVER:'http://127.0.0.1:1'}),/differs from the reviewed endpoint/);
 assert.equal(f.calls.length,1);
});

for(const [label,status,body]of [['server failure',503,'private-error'],['refused',409,'private-error'],['invalid JSON',200,'private-error'],['wrong selector',200,JSON.stringify({...approved(),archive:deployment})],['unheld',200,JSON.stringify({...approved(),execution:'running'})],['oversized',200,'x'.repeat(65537)]])test(`${label} after approval remains uncertain without retry`,async t=>{
 const f=await fixture(t,(request,response)=>{if(request.url==='/v1/admin')response.end(JSON.stringify({csrf}));else if(request.method==='GET')response.end(JSON.stringify(review()));else{response.statusCode=status;response.end(body);}}),path=await file(f);
 await assert.rejects(f.invoke(['alpha','approve','--review',path]),error=>error.stdout===''&&/is uncertain/.test(error.stderr)&&!error.stderr.includes('private-error'));
 assert.deepEqual(f.calls.map(c=>c.method),['GET','GET','POST']);
});

test('lost staging reply is uncertain and does not resend secret values',async t=>{
 const f=await fixture(t,(request,response)=>{if(request.url==='/v1/admin')response.end(JSON.stringify({csrf}));else if(request.method==='GET')response.end(JSON.stringify(review()));else{request.resume();request.on('end',()=>response.destroy());}}),path=await file(f);
 await assert.rejects(f.invoke(['alpha','secrets','--review',path],{},JSON.stringify({API_KEY:'private-lost-value'})),error=>/staging is uncertain/.test(error.stderr)&&!error.stderr.includes('private-lost-value')&&error.stdout==='');
 assert.deepEqual(f.calls.map(c=>c.method),['GET','GET','PUT']);
});

for(const args of [[],['../app'],['alpha','unknown'],['alpha','approve'],['alpha','secrets','--rotation','--review','file'],['alpha','review','--review','file'],['alpha','approve','--review','file','--output','other']])test(`invalid owner recovery arguments refuse before HTTP: ${JSON.stringify(args)}`,async t=>{
 const f=await fixture(t,(_,response)=>response.end('private-error'));await assert.rejects(f.invoke(args),error=>error.stdout===''&&!error.stderr.includes('private-error'));assert.deepEqual(f.calls,[]);
});

test('a FIFO review is rejected without reading it or contacting the controller',async t=>{
 const f=await fixture(t,(_,response)=>response.end('private-error')),path=join(f.root,'fifo');execFileSync('mkfifo',[path]);
 await assert.rejects(f.invoke(['alpha','approve','--review',path]),/Unsupported local metadata file/);assert.deepEqual(f.calls,[]);assert.equal((await lstat(path)).isFIFO(),true);
});
