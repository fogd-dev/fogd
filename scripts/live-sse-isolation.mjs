// Same native Void stream id, topic, and room name across independently routed apps.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { context } from './queue-probe/context.mjs';
import { chromium, expect } from './guestbook-browser.mjs';
const probe=await context('slot-2',process.argv[2]);
assert.match(probe.config.name,/^fogd-m11b[a-z0-9-]*$/);
const browser=await chromium.launch({args:['--host-resolver-rules=MAP checklist.localhost 127.0.0.1, MAP live-probe.localhost 127.0.0.1']});
const room=`isolation-${randomUUID()}`,errors=[],apps=[];
try {
  for(const name of ['checklist','live-probe']) {
    const writer=await browser.newPage(),watcher=await browser.newPage();
    for(const page of [writer,watcher])page.on('pageerror',error=>errors.push({app:name,error:error.message}));
    await watcher.addInitScript(()=>{
      const Native=window.EventSource;window.events=[];
      window.EventSource=class extends Native{constructor(...args){super(...args);for(const type of ['open','error','message'])this.addEventListener(type,e=>window.events.push({type,at:Date.now(),...(type==='message'?{data:JSON.parse(e.data)}:{})}));}};
    });
    const origin=`http://${name}.localhost:${probe.env.FOGD_HTTP_PORT}`;
    await writer.goto(`${origin}/?room=${room}`);await expect(writer.getByRole('status')).toHaveText('Connected · Revision 0 · 0 pending');
    await watcher.goto(`${origin}/watch?room=${room}`);await expect(watcher.getByRole('status')).toHaveText('Live · Revision 0');
    apps.push({name,writer,watcher,revision:0,texts:[]});
  }
  const hints=app=>app.watcher.evaluate(()=>window.events.filter(e=>e.type==='message').map(e=>e.data.data.revision));
  async function edit(index,text) {
    const app=apps[index],other=apps[1-index],otherHints=await hints(other);app.revision++;app.texts.push(text);
    await app.writer.getByLabel('New item').fill(text);await app.writer.getByRole('button',{name:'Add item',exact:true}).click();
    await expect(app.writer.getByRole('status')).toHaveText(`Connected · Revision ${app.revision} · 0 pending`);
    await expect(app.watcher.getByRole('status')).toHaveText(`Live · Revision ${app.revision}`);
    await expect.poll(()=>hints(app)).toEqual(Array.from({length:app.revision},(_,i)=>i+1));
    await expect(other.watcher.getByRole('status')).toHaveText(`Live · Revision ${other.revision}`);
    assert.deepEqual(await hints(other),otherHints);
  }
  await edit(0,'Checklist private-to-app item');
  await edit(1,'Live-probe first item');await edit(1,'Live-probe second item');
  await edit(0,'Checklist second item');await edit(0,'Checklist third item');
  const quietStartedAt=Date.now();await apps[0].watcher.waitForTimeout(2000);
  const results=[];
  for(const app of apps) {
    const events=await app.watcher.evaluate(()=>window.events);
    assert.equal(events.filter(e=>e.type==='open').length,1);assert.equal(events.filter(e=>e.type==='error').length,0);
    for(const event of events.filter(e=>e.type==='message')){assert.equal(event.data.subscriptionId,'board');assert.equal(event.data.topic,room);}
    assert.deepEqual(await hints(app),Array.from({length:app.revision},(_,i)=>i+1));
    const snapshot=await app.writer.evaluate(async room=>(await(await fetch(`/rooms/${room}`)).json()),room);
    assert.equal(snapshot.revision,app.revision);assert.deepEqual(snapshot.items.map(item=>item.text).sort(),app.texts.toSorted());
    results.push({app:app.name,events,snapshot});
  }
  assert.deepEqual(errors,[]);
  await probe.save('isolation',{room,results,errors,quietStartedAt,finishedAt:Date.now(),scope:'Two approved apps through hostname routing; same stream/topic/room names, interleaved edits and two-second quiet observation; no hostile-tenant security claim'});
  console.log('PASS: native SSE notifications and board data stay within each app');
} catch(error){await probe.save('failure',{room,error:error.message,errors,events:await Promise.all(apps.map(async app=>({app:app.name,events:await app.watcher.evaluate(()=>window.events).catch(()=>null)})))});throw error;}
finally {await browser.close();}
