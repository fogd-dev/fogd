// Execute upstream methods with an in-memory storage/transport seam and delayed registration reply.
import assert from 'node:assert/strict';
import { loadSource } from './void-live-probe/harness.mjs';
const path = process.argv[2]; assert.ok(path, 'Supply upstream runtime/live-server.ts or installed live-server.mjs');
const createLiveDurableObject = await loadSource(path);
const rows = new Map();
const storage = { list: async ({prefix}) => new Map([...rows].filter(([k])=>k.startsWith(prefix))), put: async (k,v)=>rows.set(k,v), delete: async keys=>{for(const k of Array.isArray(keys)?keys:[keys])rows.delete(k);}, setAlarm: async()=>{} };
const Class = createLiveDurableObject(), connection = new Class({storage},{}), topic = new Class({storage},{});
const limits = {maxSubscriptionsPerConnection:8,maxSubscriptionsPerTopic:8,maxQueuedEventsPerConnection:8,maxEncodedEventSize:4096,deliveryAttemptTimeoutMs:1000};
const received=[];
connection.connection = {stream:{send:async event=>received.push(event)},abort:new AbortController(),owner:null,generation:1,subscriptions:new Map(),pending:new Map(),writeChain:Promise.resolve(),queued:0,limits};
let release, registered;
const delayed = new Promise(resolve=>{release=resolve;}), inserted=new Promise(resolve=>{registered=resolve;});
connection.topicStub=()=>({fetch:async(url,init)=>{
  const response=await topic.fetch(new Request(url,init));
  if(new URL(url).pathname==='/register'){registered();await delayed;}
  return response;
}});
topic.connectionStub=()=>({fetch:(url,init)=>connection.fetch(new Request(url,init))});
const control = connection.fetch(new Request('http://live/control',{method:'POST',body:JSON.stringify({streamId:'test',connectionId:'connection',owner:null,limits,operations:[{kind:'subscribe',id:'board',topic:'room'}]})}));
await inserted; assert.equal(rows.size,1);
async function publish(revision){return topic.fetch(new Request('http://live/publish',{method:'POST',body:JSON.stringify({streamId:'test',topic:'room',topicKey:'room',data:{revision},limits})}));}
await publish(1); const rowsDuringRegister=rows.size;
release(); const result=await (await control).json();
await publish(2); await connection.connection.writeChain;
const evidence={accepted:result.results[0].ok,rowsDuringRegister,rowsAfter:rows.size,received:received.map(e=>e.data.data.revision),scope:'Actual upstream control/register/publish/deliver methods with modelled storage and delayed transport response; not a celld scheduling test'};
console.log(JSON.stringify(evidence,null,2));
assert.equal(evidence.accepted,true);
assert.ok(evidence.received.includes(2),'Successful subscription lost later hints after concurrent registration delivery');
