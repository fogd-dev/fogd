import assert from 'node:assert/strict';
import {chromium,expect} from './guestbook-browser.mjs';
export async function restoreBrowser(origin,room){
  const browser=await chromium.launch({args:[`--host-resolver-rules=MAP ${new URL(origin).hostname} 127.0.0.1`]});
  const context=await browser.newContext(),frames=[],serverFrames=[],errors=[];let allow=true;
  await context.addInitScript(()=>{
    const Native=window.WebSocket;window.sockets=[];window.events=[];
    window.WebSocket=class extends Native{constructor(...args){super(...args);const socket=window.sockets.push(this);for(const type of ['open','close','message'])this.addEventListener(type,e=>window.events.push({socket,type,at:Date.now(),...(type==='message'?{message:JSON.parse(e.data)}:{}),...(type==='close'?{code:e.code}:{})}));}};
  });
  await context.routeWebSocket('**/rooms/**',route=>{
    if(!allow){route.onMessage(data=>frames.push({at:Date.now(),message:JSON.parse(String(data)),forwarded:false}));void route.close({code:1012,reason:'qualification reconnect hold'});return;}
    const server=route.connectToServer();route.onMessage(data=>{frames.push({at:Date.now(),message:JSON.parse(String(data)),forwarded:true});server.send(data);});server.onMessage(data=>{serverFrames.push({at:Date.now(),message:JSON.parse(String(data))});route.send(data);});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  const status=revision=>expect(page.getByRole('status')).toHaveText(`Connected · Revision ${revision} · 0 pending`,{timeout:60000});
  const snapshot=()=>page.evaluate(async room=>{const response=await fetch(`/rooms/${room}`);if(!response.ok)throw Error('snapshot status '+response.status);return response.json();},room);
  const pending=()=>page.evaluate(room=>Object.keys(localStorage).filter(k=>k.startsWith(`fogd-checklist:${room}:pending:`)).map(k=>JSON.parse(localStorage[k])),room);
  const edit=async text=>{await page.getByLabel('New item').fill(text);await page.getByRole('button',{name:'Add item',exact:true}).click();};
  async function replay(operation,type='ack'){
    const count=await page.evaluate(({id,type})=>window.events.filter(e=>e.message?.type===type&&e.message.opId===id).length,{id:operation.opId,type});
    await page.evaluate(message=>window.sockets.at(-1).send(JSON.stringify(message)),operation);
    await expect.poll(()=>page.evaluate(({id,type})=>window.events.filter(e=>e.message?.type===type&&e.message.opId===id).length,{id:operation.opId,type})).toBe(count+1);
    return page.evaluate(({id,type})=>window.events.filter(e=>e.message?.type===type&&e.message.opId===id).at(-1).message,{id:operation.opId,type});
  }
  async function disconnect(){allow=false;await page.evaluate(()=>window.sockets.at(-1).close(1000,'qualification offline pending work'));await expect(page.getByRole('status')).toContainText('Reconnecting');}
  try{await page.goto(`${origin}/?room=${room}`);}catch(error){await browser.close();throw error;}
  return {browser,page,frames,serverFrames,errors,status,snapshot,pending,edit,replay,disconnect,reconnect:()=>{allow=true;}};
}
export async function watchRestore(browser,origin,room){
  const page=await browser.newPage();
  await page.addInitScript(()=>{const Native=window.EventSource,send=window.fetch;window.events=[];window.controls=[];window.fetch=async(...args)=>{const response=await send(...args);if(args[1]?.method==='POST'&&new URL(String(args[0]),location.href).pathname==='/live')window.controls.push({at:Date.now(),status:response.status,body:await response.clone().json().catch(()=>null)});return response;};window.EventSource=class extends Native{constructor(...args){super(...args);for(const type of ['open','error','message'])this.addEventListener(type,e=>window.events.push({type,at:Date.now(),...(type==='message'?{data:JSON.parse(e.data)}:{})}));}};});
  await page.goto(`${origin}/watch?room=${room}`);await expect(page.getByRole('status')).toHaveText('Live · Revision 2');return page;
}
