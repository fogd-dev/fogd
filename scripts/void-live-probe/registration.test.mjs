import {test} from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {loadSource,world,deferred} from './harness.mjs';
const installedURL = new URL('./live-server.mjs', import.meta.resolve('void/live'));
assert.equal(typeof (await import(installedURL.href)).createLiveDurableObject, 'function');
const create=await loadSource(process.env.FOGD_VOID_LIVE_SOURCE || fileURLToPath(new URL('./live-server.mjs', import.meta.resolve('void/live'))));
function hold(w,where='afterRegister',match=()=>true){const entered=deferred(),release=deferred();w.hooks[where]=async row=>{if(match(row)){entered.resolve(row);await release.promise;}};return {entered:entered.promise,release:()=>release.resolve(),reject:error=>release.reject(error)};}

test('initial registration survives delivery and prune check before the reply',async()=>{
  const w=await world(create);try{const h=hold(w),pending=w.subscribe();await h.entered;
    assert.deepEqual((await w.check(w.rows())).stale,[]);await w.publish(1);assert.equal(w.rows().length,1);
    h.release();assert.equal((await pending).results[0].ok,true);await w.publish(2);
    assert.ok(w.received.some(e=>e.data.revision===2));assert.equal(w.connection.connection.pending.size,0);
  }finally{await w.close();}
});

test('resubscription row survives publication while registration is pending',async()=>{
  const w=await world(create);try{await w.subscribe();const first=w.rows()[0].revision;
    const h=hold(w),pending=w.subscribe();await h.entered;await w.publish(1);h.release();await pending;await w.publish(2);
    assert.equal(w.rows().length,1);assert.ok(w.rows()[0].revision>first);assert.ok(w.received.some(e=>e.data.revision===2));
  }finally{await w.close();}
});

test('failed replacement retains prior subscription and clears pending reservations',async()=>{
  for(const failure of ['throw','full']){const w=await world(create,{maxSubscriptionsPerTopic:1});try{
    await w.subscribe();if(failure==='full')await w.subscribe('other','occupant');
    const h=hold(w,'beforeRegister',row=>row.subscriptionId==='board');const pending=w.subscribe('other').then(value=>({value}),error=>({error}));await h.entered;
    await w.publish(1);
    if(failure==='throw')h.reject(Error('transport before register'));else h.release();
    const result=await pending;
    if(failure==='full')assert.equal(result.value.results[0].ok,false);
    else assert.match(result.error.message,/transport/);
    await w.publish(2);assert.ok(w.received.some(e=>e.data.revision===2));assert.equal(w.connection.connection.pending.size,0);
  }finally{await w.close();}}
});

test('same-id requests arriving in reverse order cannot remove the winner row',async()=>{
  const w=await world(create);try{const h=hold(w,'beforeRegister',row=>row.revision===1),older=w.subscribe();await h.entered;
    const newer=await w.subscribe();h.release();await older;assert.equal(newer.results[0].ok,true);
    assert.equal(w.rows().length,1);assert.equal(w.rows()[0].revision,2);await w.publish(2);assert.ok(w.received.some(e=>e.data.revision===2));
  }finally{await w.close();}
});

test('overlapping different topics clean up the losing row',async()=>{
  const w=await world(create);try{const h=hold(w,'afterRegister',row=>row.topic==='old'),older=w.subscribe('old');await h.entered;
    await w.subscribe('new');h.release();await older;assert.equal(w.rows('old').length,0);assert.equal(w.rows('new').length,1);
    assert.equal(w.connection.connection.subscriptions.get('board').topic,'new');
  }finally{await w.close();}
});

test('unsubscribe cancels pending registration, with failed cleanup pruned by publication',async()=>{
  for(const failCleanup of [false,true]){const w=await world(create);try{const h=hold(w),pending=w.subscribe();await h.entered;
    if(failCleanup)w.hooks.beforeUnregister=async()=>{throw Error('cleanup unavailable');};
    await w.unsubscribe();h.release();await pending;assert.equal(w.connection.connection.subscriptions.size,0);
    await w.publish(1);assert.equal(w.rows().length,0);
  }finally{w.hooks.beforeUnregister=async()=>{};await w.close();}}
});

test('reconnect and close cannot install an old in-flight subscription',async()=>{
  for(const reconnect of [true,false]){const w=await world(create);try{const h=hold(w),pending=w.subscribe();await h.entered;
    if(reconnect)await w.open();else await w.close();h.release();await pending;
    assert.equal(w.connection.connection?.subscriptions.size||0,0);assert.equal(w.rows().length,0);
  }finally{await w.close();}}
});

test('topic capacity and connection capacity count pending registrations',async()=>{
  const w=await world(create,{maxSubscriptionsPerTopic:1,maxSubscriptionsPerConnection:1});try{const h=hold(w),pending=w.subscribe();await h.entered;
    const denied=await w.subscribe('room','second');assert.equal(denied.results[0].error.code,'SUBSCRIPTION_LIMIT');
    const topic=w.topics.get('room').instance;
    await topic.alarm();assert.equal(w.rows().length,1);
    const full=await topic.fetch(new Request('http://live/register',{method:'POST',body:JSON.stringify({...w.rows()[0],subscriptionId:'competing',limits:w.limits})}));
    assert.equal(full.status,409);assert.equal(w.rows().length,1);
    assert.deepEqual((await w.check(w.rows())).stale,[]);h.release();await pending;assert.equal(w.rows().length,1);
  }finally{await w.close();}
});


test('ambiguous post-registration transport failure is reported and a fresh retry repairs membership',async()=>{
  const w=await world(create);try{await w.subscribe();
    w.hooks.afterRegister=async()=>{throw Error('reply lost after registration');};
    await assert.rejects(w.subscribe(),/reply lost/);assert.equal(w.connection.connection.pending.size,0);
    w.hooks.afterRegister=async()=>{};assert.equal((await w.subscribe()).results[0].ok,true);
    await w.publish(9);assert.ok(w.received.some(e=>e.data.revision===9));assert.equal(w.rows().length,1);
  }finally{await w.close();}
});

test('a committed replacement stays active while its old-row cleanup is delayed',async()=>{
  const w=await world(create);try{await w.subscribe();const cleanup=hold(w,'beforeUnregister',row=>row.revision===1);
    const committed=w.subscribe();await cleanup.entered;
    const attempt=hold(w,'beforeRegister',row=>row.revision===3),failed=w.subscribe('other').catch(error=>error);await attempt.entered;
    await w.publish(11);assert.ok(w.received.some(e=>e.data.revision===11));
    attempt.reject(Error('newer attempt failed'));await failed;cleanup.release();await committed;
    await w.publish(12);assert.ok(w.received.some(e=>e.data.revision===12));
  }finally{await w.close();}
});


test('overlapping capacity checks cannot admit two rows into one topic slot',async()=>{
  const w=await world(create,{maxSubscriptionsPerTopic:1});try{
    await w.subscribe('room','departing');w.hooks.beforeUnregister=async()=>{throw Error('cleanup failed');};
    await w.unsubscribe('departing');w.hooks.beforeUnregister=async()=>{};
    const entered=deferred(),release=deferred();let checks=0;
    w.hooks.afterCheck=async()=>{if(++checks===1){entered.resolve();await release.promise;}};
    const first=w.subscribe('room','first');await entered.promise;
    const secondEntered=deferred();w.hooks.beforeRegister=async row=>{if(row.subscriptionId==='second')secondEntered.resolve();};
    const second=w.subscribe('room','second');await secondEntered.promise;
    // Permit a second handler to run, then let the first capacity check finish.
    await new Promise(resolve=>setImmediate(resolve));release.resolve();
    const results=await Promise.all([first,second]);
    assert.equal(results.filter(result=>result.results[0].ok).length,1);assert.equal(w.rows().length,1);
  }finally{await w.close();}
});


test('publication and unsubscribe proceed while a register capacity check is held',async()=>{
  const w=await world(create,{maxSubscriptionsPerTopic:1});let release;
  try {
    await w.subscribe('room','departing');w.hooks.beforeUnregister=async()=>{throw Error('cleanup unavailable');};
    await w.unsubscribe('departing');w.hooks.beforeUnregister=async()=>{};
    const gate=deferred(),entered=deferred();release=()=>gate.resolve();
    w.hooks.afterCheck=async()=>{entered.resolve();await gate.promise;};
    let settled=false;const pending=w.subscribe('room','waiting').finally(()=>{settled=true;});await entered.promise;
    assert.equal((await w.publish(1)).status,200);
    assert.equal((await w.unsubscribe('waiting')).results[0].ok,true);assert.equal(settled,false);
    release();assert.equal((await pending).results[0].ok,false);assert.equal(w.rows().length,0);
  }finally{release?.();await w.close();}
});
