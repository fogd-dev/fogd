import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
export const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;});return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
export async function loadSource(path) {
  console.log(`Void live source under test: ${path}`);
  const source = (await readFile(path,'utf8')).replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm,'')
    .replace(/constructor\(\s*public readonly state: DurableObjectState,\s*public readonly env: LiveDurableObjectEnv,\s*\) \{\}/,'constructor(state,env){this.state=state;this.env=env;}');
  const stubs = `const topicDigest=async(_s,t)=>t,internalUrl=p=>'http://live'+p;
const connectionInstanceName=(_s,c)=>c,topicInstanceName=(_s,t)=>t,__getLiveBindingName=()=> 'LIVE';
function eventStream(fn,{signal}) { return globalThis.__fogdLiveProbeStream(fn,signal); }\n`;
  return (await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(stubs+source,{mode:'strip'})).toString('base64'))).createLiveDurableObject;
}
function storage() {
  const values=new Map();
  return { values, get:async key=>values.get(key), put:async(key,value)=>{values.set(key,value);},
    list:async({prefix})=>new Map([...values].filter(([key])=>key.startsWith(prefix))),
    delete:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])values.delete(key);},setAlarm:async()=>{} };
}
export async function world(create, limitsOverride={}) {
  const Class=create(), state=storage(), connection=new Class({storage:state},{}), topics=new Map(), received=[];
  const limits={maxSubscriptionsPerConnection:8,maxSubscriptionsPerTopic:8,maxQueuedEventsPerConnection:8,maxEncodedEventSize:4096,deliveryAttemptTimeoutMs:1000,...limitsOverride};
  const hooks={beforeRegister:async()=>{},afterRegister:async()=>{},beforeUnregister:async()=>{},afterCheck:async()=>{}};
  globalThis.__fogdLiveProbeStream=(fn,signal)=>{
    const done=deferred(); signal.addEventListener('abort',()=>done.resolve(),{once:true});
    void fn({comment:async()=>{},send:async event=>{received.push(event.data);},closed:done.promise});
    return new Response('stream seam');
  };
  const request=(object,path,body)=>object.fetch(new Request('http://live'+path,{method:'POST',body:JSON.stringify(body)}));
  const topic=key=>{
    if(!topics.has(key)) {
      const store=storage(), instance=new Class({storage:store},{});
      instance.connectionStub=()=>({fetch:async(url,init)=>{const response=await connection.fetch(new Request(url,init));if(new URL(url).pathname==='/check')await hooks.afterCheck(JSON.parse(init.body));return response;}});
      topics.set(key,{instance,store});
    }
    return topics.get(key);
  };
  connection.topicStub=(_stream,key)=>({fetch:async(url,init)=>{
    const path=new URL(url).pathname, row=JSON.parse(init.body);
    if(path==='/register')await hooks.beforeRegister(row);
    if(path==='/unregister')await hooks.beforeUnregister(row);
    const response=await topic(key).instance.fetch(new Request(url,init));
    if(path==='/register')await hooks.afterRegister(row,response);
    return response;
  }});
  const open=()=>request(connection,'/connect',{streamId:'test',connectionId:'connection',owner:null,limits});
  const control=async operations=>(await request(connection,'/control',{streamId:'test',connectionId:'connection',owner:null,limits,operations})).json();
  await open();
  return {connection,topics,received,hooks,limits,open,control,
    subscribe:(topic='room',id='board')=>control([{kind:'subscribe',topic,id}]),
    unsubscribe:(id='board')=>control([{kind:'unsubscribe',id}]),
    rows:(key='room')=>[...topic(key).store.values.values()],
    publish:async(revision,key='room')=>{const response=await request(topic(key).instance,'/publish',{streamId:'test',topic:key,topicKey:key,data:{revision},limits});await connection.connection?.writeChain;return response;},
    check:async rows=>(await request(connection,'/check',{subscriptions:rows})).json(),
    async close(){connection.connection?.abort.abort();await tick();},
  };
}
