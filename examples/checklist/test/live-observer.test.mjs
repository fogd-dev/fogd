import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeChecklist } from '../lib/live-observer.mjs';
globalThis.location = { href: 'http://checklist.localhost/watch?room=shared' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = revision => ({ type: 'snapshot', release: 'v1', revision, items: [] });
function harness(response) {
  const sources = [], controls = [], reads = [];
  class Source extends EventTarget { constructor() { super(); sources.push(this); queueMicrotask(()=>this.dispatchEvent(new Event('open'))); } close() {} }
  const run = observeChecklist('shared', async () => { reads.push(controls.length); return snapshot(controls.length); }, () => {}, {
    eventSource: Source, retryDelay: 1,
    fetch: async (_url, init) => { const input=JSON.parse(init.body);controls.push(input); return response(input,controls.length); },
  });
  return { ...run, sources, controls, reads };
}
const success = input => Response.json({accepted:true,results:input.operations.map(op=>({...op,ok:true}))});

test('actual Void client registers and resubscribes before the observer reads', async () => {
  const h=harness(success);
  try {
    await tick(); await tick(); assert.deepEqual(h.reads,[1]);
    h.sources[0].dispatchEvent(new Event('error')); assert.equal(h.observer.view.status,'Reconnecting');
    await new Promise(resolve=>setTimeout(resolve,15)); await tick();
    assert.equal(h.sources.length,2); assert.deepEqual(h.reads,[1,2]);assert.equal(h.observer.view.revision,2);
  } finally { h.close(); }
});

test('initial and repeat subscription refusal show a terminal retry state', async () => {
  for(const failAt of [1,2]) {
    const h=harness((input,count)=>count===failAt ? Response.json({accepted:false,error:{message:'refused'}},{status:503}):success(input));
    try {
      await tick(); await tick();
      if(failAt===2){h.sources[0].dispatchEvent(new Event('error'));await new Promise(resolve=>setTimeout(resolve,15));await tick();}
      assert.equal(h.observer.view.status,'Not subscribed'); assert.equal(h.observer.registered,false);
      assert.equal(h.reads.length,failAt-1);
    } finally { h.close(); }
  }
});

test('malformed SDK notification refreshes state without invalidating registration', async () => {
  const h=harness(success);
  try {
    await tick(); await tick();
    const epoch=h.observer.epoch;
    h.sources[0].dispatchEvent(new MessageEvent('message',{data:'{bad json'}));
    await tick();
    assert.equal(h.observer.epoch,epoch); assert.equal(h.observer.registered,true);assert.equal(h.reads.length,2);
  } finally {h.close();}
});
